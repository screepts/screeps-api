import yaml from "js-yaml"

/**
 * Unified Credentials File v1.0.
 * A standardized format for storing credentials and configuration for Screeps World related tools.
 * @link https://github.com/screepers/screepers-standards/blob/master/SS3-Unified_Credentials_File.md
 */
export interface UnifiedConfig {
  servers: Partial<Record<string, ServerConfig>>
  configs?: Partial<Record<string, any>>
  [metadata: string]: any
}
interface ServerConfig {
  host: string
  /** override standard TCP port */
  port?: number
  /** use SSL */
  secure?: boolean
  /** authorization token */
  token?: string
  /** is only supported on private servers */
  username?: string
  /** is only supported on private servers */
  password?: string
  /** additional metadata like ptr flag */
  [metadata: string]: any
}

/**
 * Utility class for loading Unified Credentials Files from disk, environment variables, or other sources.
 * Only platforms without filesystem access, {@link ConfigManager.setConfig}, must be used to provide the config data directly.
 */
export class ConfigManager {
  path?: string
  private _config: UnifiedConfig | null = null

  /** Custom environment variables, useful for platforms without process.env */
  env: Record<string, string | undefined> = globalThis.process?.env || {}
  /** Custom file reading function, useful for platforms with a virtual filesystem */
  readFile?: (path: string, options: { encoding: "utf8" }) => Promise<string>

  setConfig(data: unknown, path?: string) {
    if (!data || typeof data !== "object" || !("servers" in data)) {
      throw new Error(`Invalid config: 'servers' object does not exist in '${path}'`)
    }
    this._config = data as UnifiedConfig
    this.path = path
    return this._config
  }

  async refresh() {
    this._config = null
    await this.getConfig()
  }

  async getServers() {
    const conf = await this.getConfig()
    return conf ? Object.keys(conf.servers) : []
  }

  async getConfig() {
    if (this._config) {
      return this._config
    }

    const paths = []
    if (this.env.SCREEPS_CONFIG) {
      paths.push(this.env.SCREEPS_CONFIG)
    }
    const dirs = ["", import.meta.dirname]
    for (const dir of dirs) {
      paths.push(join(dir, ".screeps.yaml"))
      paths.push(join(dir, ".screeps.yml"))
    }
    if (process.platform === "win32" && this.env.APPDATA) {
      paths.push(join(this.env.APPDATA, "screeps/config.yaml"))
      paths.push(join(this.env.APPDATA, "screeps/config.yml"))
    } else {
      if (this.env.XDG_CONFIG_HOME) {
        paths.push(join(this.env.XDG_CONFIG_HOME, "screeps/config.yaml"))
        paths.push(join(this.env.XDG_CONFIG_HOME, "screeps/config.yml"))
      }
      if (this.env.HOME) {
        paths.push(join(this.env.HOME, ".config/screeps/config.yaml"))
        paths.push(join(this.env.HOME, ".config/screeps/config.yml"))
        paths.push(join(this.env.HOME, ".screeps.yaml"))
        paths.push(join(this.env.HOME, ".screeps.yml"))
      }
    }

    for (const path of paths) {
      const data = await this.loadConfig(path)
      if (data) return data
    }
    return null
  }

  async loadConfig(path: string) {
    if (!this.readFile) {
      const { readFile } = await import("fs/promises")
      this.readFile = readFile
    }
    let contents: string
    try {
      contents = await this.readFile(path, { encoding: "utf8" })
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "ENOENT") {
        return null
      } else {
        throw e
      }
    }
    const data = yaml.load(contents)
    return this.setConfig(data, path)
  }
}

function join(a: string, b: string) {
  return a + (a.endsWith("/") ? "" : "/") + b
}
