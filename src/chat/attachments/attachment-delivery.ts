import {
  type Attachment,
  UploadRefused,
  inspectAttachment,
  maxAttachmentTotalBytes,
  maxAttachments,
  opencodeScratchDirectory,
  readPreparedAttachment,
} from "./attachments";
import type { BackendConfig } from "../../config";
import { isLocalhost } from "../../lib/loopback";
import type { AttachmentRecords } from "./store";

/** Slack-style three-step upload: reserve, put, then complete in a thread. */
export interface UploadTransport {
  reserveUpload(
    name: string,
    length: number,
    signal: AbortSignal,
  ): Promise<{ fileID: string; url: string }>;
  putUpload(url: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
  completeUpload(
    channel: string,
    thread: string,
    fileID: string,
    title: string,
    signal: AbortSignal,
  ): Promise<void>;
  sharedIn(
    fileID: string,
    channel: string,
    thread: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}

/**
 * One-step upload (IRC FILEHOST): a durable URL, then a link in the thread.
 * "uploading" is stored before the upload and the URL before the link is
 * posted, so a retry never uploads a file again: an upload that may have
 * run (crash, lost answer, timeout) makes the file unavailable with a
 * notice. Only `UploadRefused` (the host certainly stored nothing, for
 * example a 401 or 413 from a FILEHOST) allows another upload. A crash
 * between post and record can repeat the link.
 */
export interface LinkTransport {
  /** Publication is one-shot; an uncertain send must never publish again. */
  publishOnce?: boolean;
  upload(file: Attachment, signal: AbortSignal): Promise<string>;
  link(
    channel: string,
    thread: string,
    url: string,
    title: string,
    signal: AbortSignal,
    allowed?: () => boolean,
  ): Promise<void>;
}

/** Input downloads, plus uploads when the transport can publish files. */
export interface AttachmentTransport
  extends Partial<UploadTransport>, Partial<LinkTransport> {
  download(
    ids: readonly string[],
    channel: string,
    signal: AbortSignal,
  ): Promise<Attachment[]>;
}

/** The transport's link-style upload half, if it has one. */
function links(
  transport: AttachmentTransport | undefined,
): LinkTransport | undefined {
  if (!transport?.upload || !transport.link) {
    return;
  }

  const { upload, link } = transport;

  return {
    upload: upload.bind(transport),
    link: link.bind(transport),
    ...(transport.publishOnce && { publishOnce: true }),
  };
}

/** The transport's upload half, or undefined for a download-only one. */
function uploads(
  transport: AttachmentTransport | undefined,
): UploadTransport | undefined {
  if (
    !transport?.reserveUpload ||
    !transport.putUpload ||
    !transport.completeUpload ||
    !transport.sharedIn
  ) {
    return;
  }

  const { reserveUpload, putUpload, completeUpload, sharedIn } = transport;

  return {
    reserveUpload: reserveUpload.bind(transport),
    putUpload: putUpload.bind(transport),
    completeUpload: completeUpload.bind(transport),
    sharedIn: sharedIn.bind(transport),
  };
}

/**
 * A published path is readable only where the agent wrote it: every backend
 * except an OpenCode server on another host.
 */
export function agentFilesLocal(backend: BackendConfig) {
  return (
    backend.type !== "opencode" || isLocalhost(new URL(backend.url).hostname)
  );
}

function attachmentTitle(caption: string, name: string) {
  return (
    Array.from(caption || name)
      .map((char) =>
        char === "/" ||
        char === "\\" ||
        char.charCodeAt(0) < 32 ||
        char.charCodeAt(0) === 127
          ? " "
          : char,
      )
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 255)
      .trim() || name
  );
}

/** Only scratch descendants may bypass hidden ancestor segments. */
function scratchRoot(path: string) {
  const root = opencodeScratchDirectory();

  return path.startsWith(`${root}/`) ? root : undefined;
}

/**
 * Publish the files of one stored reply, after its text. Each file moves
 * through `AttachmentDelivery.phase`; the phase is saved before the step
 * that it names, so a retry knows what may have happened.
 *
 * - Upload transport (Slack): (none) → reserved → uploaded → completing →
 *   shared. A reserved or uploaded file is not public, so a retry before
 *   `uploaded` reserves a new ID and uploads again, and the earlier ID is
 *   never completed. Completion publishes: a retry in `completing` asks
 *   whether the file is shared and never completes again.
 * - Link transport (IRC FILEHOST): (none) → uploading → uploaded → shared.
 *   The upload itself stores the file, so a retry in `uploading` never
 *   uploads again; only `UploadRefused` clears the phase. A retry in
 *   `uploaded` posts the recorded URL.
 * - Any phase → unavailable, with one notice per job.
 *
 * Throws when access was removed, on shutdown and on a transport failure;
 * the caller retries delivery.
 */
export async function deliverAttachments(
  job: { id: number; channel: string; thread: string },
  context: {
    store: Pick<AttachmentRecords, "attachments" | "saveAttachments">;
    /** Undefined while the transport cannot move files. */
    transport: AttachmentTransport | undefined;
    /** The agent's files are on this host; see `agentFilesLocal`. */
    local: boolean;
    /** Post a short notice in the job's thread. */
    notify(text: string): Promise<unknown>;
    /** Current access rules; checked before every public write. */
    allowed(): boolean;
  },
  shutdown: AbortSignal,
) {
  const files = context.store.attachments(job.id);

  if (files.length === 0) {
    return;
  }

  const save = () => {
    context.store.saveAttachments(job.id, files);
  };

  const readForUpload = async (
    file: (typeof files)[number],
    prepared: NonNullable<(typeof files)[number]["prepared"]>,
  ) => {
    try {
      return await readPreparedAttachment(
        prepared,
        undefined,
        scratchRoot(prepared.path),
      );
    } catch {
      file.phase = "unavailable";
      save();
      throw new Error("Published attachment changed or became unavailable");
    }
  };

  const linked = links(context.transport);
  const transport = linked ? undefined : uploads(context.transport);

  if (
    !context.local ||
    files.length > maxAttachments ||
    !(transport || linked)
  ) {
    for (const file of files) {
      file.phase = "unavailable";
    }

    save();
  } else {
    for (const file of files) {
      if (file.phase || file.prepared) {
        continue;
      }

      try {
        file.prepared = await inspectAttachment(
          file,
          undefined,
          scratchRoot(file.path),
        );
      } catch {
        file.phase = "unavailable";
      }

      save();
    }

    if (
      files.reduce((sum, file) => sum + (file.prepared?.size ?? 0), 0) >
      maxAttachmentTotalBytes
    ) {
      for (const file of files) {
        if (file.phase !== "shared") {
          file.phase = "unavailable";
        }
      }

      save();
    }
  }

  for (const file of files) {
    shutdown.throwIfAborted();

    if (!context.allowed()) {
      throw new Error("Attachment delivery access denied");
    }

    if (file.phase === "shared") {
      continue;
    }

    if (file.phase === "completing" && linked?.publishOnce) {
      file.phase = "unavailable";
      save();
    }

    if (file.prepared && !file.title) {
      file.title = attachmentTitle(file.caption, file.prepared.name);
      save();
    }

    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(30_000)]);

    if (file.phase === "completing" && file.fileID && transport) {
      if (
        await transport.sharedIn(file.fileID, job.channel, job.thread, signal)
      ) {
        file.phase = "shared";
        save();
        continue;
      }

      // Completion is one-shot. Absence of a share is not proof it never ran.
      file.phase = "unavailable";
      save();
    }

    if (file.phase === "uploading" && !file.fileID) {
      // The last upload attempt had no certain outcome: never repeat it.
      file.phase = "unavailable";
      save();
    }

    if (
      file.phase === "unavailable" ||
      !file.prepared ||
      !(transport || linked)
    ) {
      if (!file.noticeSent) {
        if (!context.allowed()) {
          throw new Error("Attachment delivery access denied");
        }

        if (!files.some((item) => item.noticeSent)) {
          await context.notify(
            "An attachment is unavailable or its upload is unconfirmed. The agent work was not rerun.",
          );
        }

        file.noticeSent = true;
        save();
      }

      continue;
    }

    if (linked) {
      // Record the hosted URL first: a retry posts it, never re-uploads.
      if (!file.fileID) {
        const content = await readForUpload(file, file.prepared);
        file.phase = "uploading";
        save();

        try {
          file.fileID = await linked.upload(content, signal);
        } catch (error) {
          if (error instanceof UploadRefused) {
            delete file.phase;
            save();
          }

          throw error;
        }

        file.phase = "uploaded";
        save();
      }

      if (!context.allowed()) {
        throw new Error("Attachment delivery access denied");
      }

      if (linked.publishOnce) {
        file.phase = "completing";
        save();
      }

      await linked.link(
        job.channel,
        job.thread,
        file.fileID,
        file.title ?? file.prepared.name,
        signal,
        () => context.allowed(),
      );
      file.phase = "shared";
      save();
      continue;
    }

    if (!transport) {
      continue;
    }

    if (file.phase !== "uploaded") {
      const content = await readForUpload(file, file.prepared);

      // A retry may abandon an unshared reservation, never complete both IDs.
      const reserved = await transport.reserveUpload(
        content.name,
        content.data.byteLength,
        signal,
      );

      file.fileID = reserved.fileID;
      file.phase = "reserved";
      save();
      await transport.putUpload(reserved.url, content.data, signal);
      file.phase = "uploaded";
      save();
    }

    if (!file.fileID) {
      throw new Error("Attachment upload identity missing");
    }

    if (!context.allowed()) {
      throw new Error("Attachment delivery access denied");
    }

    file.phase = "completing";
    save();
    await transport.completeUpload(
      job.channel,
      job.thread,
      file.fileID,
      file.title ?? file.prepared.name,
      signal,
    );
    file.phase = "shared";
    save();
  }
}
