import { Gateway } from "../src/gateway/gateway";
import { SlackAdmission } from "../src/transports/slack/admission";

/** Wire the Slack test intake once per gateway, as runtime does. */
export class SlackGateway extends Gateway {
  private readonly admission = new SlackAdmission(this.slackIntake());

  public receive(body: unknown, open?: () => boolean) {
    return this.admission.receive(body, open);
  }
}
