export { type BackendConfig, backendSchema } from "./backends/config";

export { secret } from "./lib/credentials";

export {
  acpBackendSchema,
  agentDispatchDefaults,
  agentDispatchSchema,
  agentDispatchTarget,
  antigravityBackendSchema,
  botSchema,
  claudeBackendSchema,
  claudeToolNames,
  codexBackendSchema,
  configSchema,
  defaultAllCallWords,
  effectiveIrcConfig,
  ircFeatureDefaults,
  ircFeedbackDefaults,
  ircSchema,
  loadConfig,
  piCrewBackendSchema,
  piDurableBackendSchema,
  pinnedSessionIDs,
  registrationIds,
  reloadConfigSchema,
  teamsSchema,
} from "./config/composition";

export type {
  AgentDispatchConfig,
  BotConfig,
  Config,
  EffectiveIrcConfig,
  IrcConfig,
  TeamsConfig,
} from "./config/composition";
