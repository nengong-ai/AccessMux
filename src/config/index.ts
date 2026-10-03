// config 模块入口
export {
  configSchema,
  formatZodError,
  type Config,
  type AdapterEntry,
  type OutputConfig,
} from './schema.js';
export {
  ConfigStore,
  ConfigError,
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONFIG_PATH,
  buildDefaultConfig,
  reconcileWithRegistry,
  loadConfigFromPath,
  saveConfigToPath,
  resolveConfigPath,
} from './store.js';
export { accessmuxConfigHome, resetAccessmuxConfigHomeCache } from './paths.js';