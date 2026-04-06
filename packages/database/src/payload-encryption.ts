import { Logger } from "@ccflare/logger";

const log = new Logger("PayloadEncryption");

// Use Web Crypto API (available in Bun natively)
const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const KEY_LENGTH = 256;

let encryptionKey: CryptoKey | null = null;

/**
 * Initialize encryption from environment variable.
 * If PAYLOAD_ENCRYPTION_KEY is not set, encryption is disabled (plaintext fallback).
 */
export async function initPayloadEncryption(): Promise<boolean> {
    const keyHex = process.env.PAYLOAD_ENCRYPTION_KEY;
    if (!keyHex) {
        log.info("PAYLOAD_ENCRYPTION_KEY not set — payloads stored in plaintext");
        return false;
    }

    try {
        const keyBytes = hexToBytes(keyHex);
        if (keyBytes.length !== 32) {
            log.error(`PAYLOAD_ENCRYPTION_KEY must be 64 hex chars (32 bytes), got ${keyHex.length} chars`);
            return false;
        }
        encryptionKey = await crypto.subtle.importKey(
            "raw",
            keyBytes,
            { name: ALGORITHM, length: KEY_LENGTH },
            false,
            ["encrypt", "decrypt"],
        );
        log.info("Payload encryption enabled (AES-256-GCM)");
        return true;
    } catch (err) {
        log.error("Failed to initialize encryption key:", err);
        return false;
    }
}

/**
 * Encrypt a JSON string. Returns base64-encoded "iv:ciphertext" or plaintext if encryption disabled.
 */
export async function encryptPayload(plaintext: string): Promise<string> {
    if (!encryptionKey) return plaintext;

    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
        { name: ALGORITHM, iv },
        encryptionKey,
        encoded,
    );

    const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), IV_LENGTH);

    return "enc:" + bytesToBase64(combined);
}

/**
 * Decrypt a payload string. Handles both encrypted ("enc:...") and plaintext formats.
 */
export async function decryptPayload(stored: string): Promise<string> {
    if (!stored.startsWith("enc:")) return stored; // plaintext fallback
    if (!encryptionKey) {
        log.warn("Encrypted payload found but no encryption key configured");
        return stored;
    }

    try {
        const combined = base64ToBytes(stored.slice(4));
        const iv = combined.slice(0, IV_LENGTH);
        const ciphertext = combined.slice(IV_LENGTH);

        const decrypted = await crypto.subtle.decrypt(
            { name: ALGORITHM, iv },
            encryptionKey,
            ciphertext,
        );
        return new TextDecoder().decode(decrypted);
    } catch (err) {
        log.error("Payload decryption failed:", err);
        return stored;
    }
}

export function isEncryptionEnabled(): boolean {
    return encryptionKey !== null;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, "base64"));
}
