/* Manages OpenAI API keys. Tracks usage, disables expired keys, and provides
round-robin access to keys. Keys are stored in the OPENAI_KEY environment
variable as a comma-separated list of keys. */
import crypto from "crypto";
import { config } from "../config";
import { logger } from "../logger";
import { KeyChecker } from "./key-checker";

export type Key = {
  /** The OpenAI API key itself. */
  key: string;
  /** Whether this is a free trial key. These are prioritized over paid keys if they can fulfill the request. */
  isTrial: boolean;
  /** Whether this key has been provisioned for GPT-4. */
  isGpt4: boolean;
  /** Whether this key is currently disabled. We set this if we get a 429 or 401 response from OpenAI. */
  isDisabled: boolean;
  /** Threshold at which a warning email will be sent by OpenAI. */
  softLimit: number;
  /** Threshold at which the key will be disabled because it has reached the user-defined limit. */
  hardLimit: number;
  /** The maximum quota allocated to this key by OpenAI. */
  systemHardLimit: number;
  /** The current usage of this key. */
  usage: number;
  /** The number of prompts that have been sent with this key. */
  promptCount: number;
  /** The time at which this key was last used. */
  lastUsed: number;
  /** The time at which this key was last checked. */
  lastChecked: number;
  /** Key hash for displaying usage in the dashboard. */
  hash: string;
};

export type KeyUpdate = Omit<
  Partial<Key>,
  "key" | "hash" | "isDisabled" | "lastUsed" | "lastChecked" | "promptCount"
>;

export class KeyPool {
  private keys: Key[] = [];
  private checker?: KeyChecker;
  private log = logger.child({ module: "KeyPool" });

  constructor() {
    const keyString = config.openaiKey;
    if (!keyString?.trim()) {
      throw new Error("OPENAI_KEY environment variable is not set");
    }
    let bareKeys: string[];
    bareKeys = keyString.split(",").map((k) => k.trim());
    for (const k of bareKeys) {
      const newKey = {
        key: k,
        isGpt4: false,
        isTrial: false,
        isDisabled: false,
        softLimit: 0,
        hardLimit: 0,
        systemHardLimit: 0,
        usage: 0,
        lastUsed: 0,
        lastChecked: 0,
        promptCount: 0,
        hash: crypto.createHash("sha256").update(k).digest("hex").slice(0, 6),
      };
      this.keys.push(newKey);

      this.log.info({ key: newKey.hash }, "Key added");
    }
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new KeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    }
  }

  /**
   * Returns a list of all keys, with the key field removed.
   * Don't mutate returned keys, use a KeyPool method instead.
   **/
  public list() {
    return this.keys.map((key) => {
      return Object.freeze({
        ...key,
        key: undefined,
      });
    });
  }

  public get(model: string) {
    const needsGpt4Key = model.startsWith("gpt-4");
    const availableKeys = this.keys.filter(
      (key) => !key.isDisabled && (!needsGpt4Key || key.isGpt4)
    );
    if (availableKeys.length === 0) {
      let message = "No keys available. Please add more keys.";
      if (needsGpt4Key) {
        message =
          "No GPT-4 keys available. Please add more keys or use a non-GPT-4 model.";
      }
      this.log.error(message);
      throw new Error(message);
    }

    // Prioritize trial keys
    const trialKeys = availableKeys.filter((key) => key.isTrial);
    if (trialKeys.length > 0) {
      this.log.info({ key: trialKeys[0].hash }, "Using trial key");
      trialKeys[0].lastUsed = Date.now();
      return trialKeys[0];
    }

    // Otherwise, return the oldest key
    const oldestKey = availableKeys.sort((a, b) => a.lastUsed - b.lastUsed)[0];
    this.log.info({ key: oldestKey.hash }, "Assigning key to request.");
    oldestKey.lastUsed = Date.now();
    return { ...oldestKey };
  }

  public update(keyHash: string, update: KeyUpdate) {
    const keyFromPool = this.keys.find((k) => k.hash === keyHash)!;
    Object.assign(keyFromPool, { ...update, lastChecked: Date.now() });
  }

  public disable(key: Key) {
    const keyFromPool = this.keys.find((k) => k.key === key.key)!;
    if (keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public anyAvailable() {
    return this.keys.some((key) => !key.isDisabled);
  }

  public anyUnchecked() {
    return config.checkKeys && this.keys.some((key) => !key.lastChecked);
  }

  public incrementPrompt(keyHash?: string) {
    if (!keyHash) return;
    const key = this.keys.find((k) => k.hash === keyHash)!;
    key.promptCount++;
  }

  public downgradeKey(keyHash?: string) {
    if (!keyHash) return;
    this.log.warn({ key: keyHash }, "Downgrading key to GPT-3.5.");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    key.isGpt4 = false;
  }

  /** Returns the remaining aggregate quota for all keys as a percentage. */
  public calculateRemainingQuota(gpt4Only = false) {
    const keys = gpt4Only ? this.keys.filter((k) => k.isGpt4) : this.keys;

    if (keys.length === 0) return 0;

    const totalUsage = keys.reduce((acc, key) => {
      // Keys can slightly exceed their quota
      return acc + Math.min(key.usage, key.hardLimit);
    }, 0);
    const totalLimit = keys.reduce((acc, { hardLimit }) => acc + hardLimit, 0);

    return 1 - totalUsage / totalLimit;
  }
}
