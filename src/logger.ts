import { Vault, normalizePath } from "obsidian";

export const LOG_FILE_NAME = "github-sync.log" as const;

export interface ErrorLogEntry {
  timestamp: string;
  level: "ERROR";
  message: string;
  additional_data?: unknown;
}

export default class Logger {
  private logFile: string;

  constructor(
    private vault: Vault,
    private enabled: boolean,
  ) {
    this.logFile = normalizePath(`${vault.configDir}/${LOG_FILE_NAME}`);
  }

  async init() {
    // Create the log file in case it doesn't exist
    if (await this.vault.adapter.exists(this.logFile)) {
      return;
    }
    this.vault.adapter.write(this.logFile, "");
  }

  private async write(
    level: string,
    message: string,
    data?: any,
  ): Promise<void> {
    if (!this.enabled && level !== "ERROR") return;

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      additional_data: data,
    };

    await this.vault.adapter.append(
      this.logFile,
      JSON.stringify(logEntry) + "\n",
    );
  }

  async read(): Promise<string> {
    return await this.vault.adapter.read(this.logFile);
  }

  async getRecentErrors(): Promise<ErrorLogEntry[]> {
    const lines = (await this.read()).split("\n");
    const errors: ErrorLogEntry[] = [];

    for (let i = lines.length - 1; i >= 0 && errors.length < 10; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        // Ignore incomplete log entries, for example after an interrupted write.
        continue;
      }
      if (
        entry?.level === "ERROR" &&
        typeof entry.timestamp === "string" &&
        typeof entry.message === "string"
      ) {
        errors.push(entry);
      }
    }

    return errors;
  }

  async clean(): Promise<void> {
    return await this.vault.adapter.write(this.logFile, "");
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  async info(message: string, data?: any): Promise<void> {
    await this.write("INFO", message, data);
  }

  async warn(message: string, data?: any): Promise<void> {
    await this.write("WARN", message, data);
  }

  async error(message: string, data?: any): Promise<void> {
    await this.write("ERROR", message, data);
  }
}
