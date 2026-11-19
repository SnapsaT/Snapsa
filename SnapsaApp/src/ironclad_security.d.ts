/* tslint:disable */
/* eslint-disable */

export class IroncladIdentityResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly commitment: Uint8Array;
    readonly encrypted_blob: Uint8Array;
    readonly iv: Uint8Array;
    readonly proof: Uint8Array;
    readonly salt: Uint8Array;
}

export class IroncladSecurity {
    free(): void;
    [Symbol.dispose](): void;
    clear_all_sessions(): void;
    clear_session(chat_id: string): void;
    decrypt(chat_id: string, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;
    decrypt_ephemeral(chat_id: string, ephemeral_ciphertext: Uint8Array, aad: Uint8Array): Uint8Array;
    derive_master_key(pin: string, salt: Uint8Array): Uint8Array;
    encrypt(chat_id: string, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
    encrypt_ephemeral(chat_id: string, plaintext: Uint8Array, aad: Uint8Array, destruct_type: string, param: bigint, screenshot_protection: boolean, prevent_forward: boolean): Uint8Array;
    ephemeral_acknowledge_destruction(message_id: string): void;
    ephemeral_attempt_view(message_id: string, current_time_ms: number): any;
    ephemeral_cleanup_expired(current_time_ms: number): any;
    ephemeral_is_destroyed(message_id: string): boolean;
    ephemeral_register(message_id: string, payload_js: any): void;
    ephemeral_remote_wipe(message_id: string, token: string): boolean;
    ephemeral_report_screenshot(message_id: string, current_time_ms: number): any;
    establish_session(chat_id: string, key: Uint8Array): void;
    generate_key(): Uint8Array;
    generate_nonce(): Uint8Array;
    generate_salt(): Uint8Array;
    generate_wipe_token(): string;
    get_session_index(chat_id: string): bigint | undefined;
    has_session(chat_id: string): boolean;
    constructor();
    security_checklist(): any;
    validate_file_size(size: number): void;
    validate_pin(pin: string): void;
    validate_recording_time(seconds: number): void;
}

export class Kex {
    free(): void;
    [Symbol.dispose](): void;
    constructor(public_key: Uint8Array);
    ciphertext: Uint8Array;
    sharedSecret: Uint8Array;
}

export class Keys {
    free(): void;
    [Symbol.dispose](): void;
    constructor();
    readonly pubkey: Uint8Array;
    readonly secret: Uint8Array;
}

export class LoginProofResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly nullifier: string;
    readonly proof_hex: string;
}

export class Params {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly ciphertextBytes: number;
    readonly publicKeyBytes: number;
    readonly secretKeyBytes: number;
    readonly sharedSecretBytes: number;
    static readonly ciphertextBytes: number;
    static readonly publicKeyBytes: number;
    static readonly secretKeyBytes: number;
    static readonly sharedSecretBytes: number;
}

export class SecureCallEngine {
    free(): void;
    [Symbol.dispose](): void;
    decrypt_rtp(session_id: string, encrypted_data: Uint8Array): Uint8Array;
    encrypt_rtp(session_id: string, data: Uint8Array, header_obj: any): Uint8Array;
    end_call(session_id: string): void;
    get_call_stats(session_id: string): any;
    get_proxy_chain_info(session_id: string): any;
    get_security_info(): any;
    init_secure_call(session_id: string, peer_id: string): any;
    constructor(config: any);
    trigger_kill_switch(session_id: string): void;
}

export class WebRTCExample {
    free(): void;
    [Symbol.dispose](): void;
    example_encrypt_decrypt(session_id: string): any;
    constructor();
}

export function bytes_to_hex(bytes: Uint8Array): string;

export function create_ephemeral_payload(inner_ciphertext: Uint8Array, destruct_type: string, param: bigint, screenshot_protection: boolean, prevent_forward: boolean, wipe_token?: string | null): any;

export function create_secure_identity(recovery_string: string, identity_json: string): IroncladIdentityResult;

export function decapsulate(ct: Uint8Array, sk: Uint8Array): Uint8Array;

/**
 * Decrypt all sensitive fields in an encrypted WernPost.
 *
 * # Returns
 * Decrypted WernPost as JSON string, with `_integrityValid` boolean added.
 * If ANY field fails integrity check, `_integrityValid` = false.
 */
export function decrypt_WernPost(master_key_hex: string, user_id: string, encrypted_WernPost_json: string): string;

/**
 * Decrypt a single WernPost field and verify integrity.
 *
 * Returns JSON string of `FieldDecryptResult`.
 * If `integrity_valid` is false, the WernPost was tampered with server-side.
 */
export function decrypt_WernPost_field(master_key_hex: string, user_id: string, encrypted_field_json: string): string;

/**
 * Decrypt an array of posts in a single WASM call.
 * More efficient than calling decrypt_post N times from JS
 * (avoids JS↔WASM boundary overhead per WernPost).
 *
 * # Arguments
 * * `master_key_hex`  – 32-byte hex master key
 * * `user_id`         – Authenticated user ID
 * * `posts_json`      – JSON array of encrypted WernPost objects
 *
 * # Returns
 * JSON array of decrypted posts
 */
export function decrypt_WernPosts_batch(master_key_hex: string, user_id: string, WernPosts_json: string): string;

export function decrypt_display_blob(encrypted_blob_js: Uint8Array, iv_js: Uint8Array): Uint8Array;

export function decrypt_display_fields(encrypted_blob_js: Uint8Array, iv_js: Uint8Array): string;

export function decrypt_signaling_message(encrypted: string, key_bytes: Uint8Array): string;

export function decrypt_user_identity(recovery_string: string, encrypted_blob_js: Uint8Array, iv_js: Uint8Array, salt_js: Uint8Array): string;

/**
 * Derive a 32-byte WernPost-encryption master key from the user's session key.
 * Call once per session. Store the result in memory only (never localStorage).
 *
 * WernPost_master = HKDF(session_key, salt = "WERNPOST-MASTER", info = userId)
 */
export function derive_WernPost_master_key(session_key_hex: string, user_id: string): string;

export function encapsulate(pk: Uint8Array): Kex;

/**
 * Encrypt all sensitive fields in a WernPost JSON object.
 *
 * # Arguments
 * * `master_key_hex` – 32-byte hex master key
 * * `user_id`        – Authenticated user ID
 * * `post_json`      – Full WernPost object as JSON string
 *
 * # Returns
 * JSON string of `PostEncryptionResult` — safe to send to server
 */
export function encrypt_WernPost(master_key_hex: string, user_id: string, WernPost_json: string): string;

/**
 * Encrypt a single WernPost field.
 *
 * # Arguments
 * * `master_key_hex`  – 32-byte AES master key as hex string (from session)
 * * `user_id`         – Authenticated user ID (bound into HKDF)
 * * `WernPost_id`         – WernPost UUID (bound into HKDF salt, unique per WernPost)
 * * `field_name`      – e.g. "content", "location" (bound into HKDF info)
 * * `plaintext`       – Raw field value (UTF-8 string)
 *
 * # Returns
 * JSON string of `EncryptedField`
 */
export function encrypt_WernPost_field(master_key_hex: string, user_id: string, WernPost_id: string, field_name: string, plaintext: string): string;

export function encrypt_display_blob(data_js: Uint8Array): object;

export function encrypt_display_field(plaintext: string): object;

export function encrypt_signaling_message(data: string, key_bytes: Uint8Array): string;

/**
 * Generate a cryptographically random 32-byte key, hex-encoded.
 * Used for fresh key generation when no session key is available.
 */
export function generate_WernPost_master_key(): string;

/**
 * Generate a standalone content integrity proof for a WernPost.
 * Store this alongside the WernPost as `zkProof`.
 * Anyone can call `verify_WernPost_integrity` to check it later.
 */
export function generate_WernPost_proof(content: string, WernPost_id: string, user_id: string): string;

export function generate_kyber_keypair(): any;

export function generate_login_proof(seed: string, challenge: string, domain: string, epoch: bigint): LoginProofResult;

export function generate_recovery_string_js(): string;

export function get_commitment(seed: string): string;

/**
 * Get the encryption version of a WernPost (for future migration).
 */
export function get_encryption_version(WernPost_json: string): number;

/**
 * Check if a WernPost object has encrypted fields (quick check without decrypting).
 */
export function is_WernPost_encrypted(WernPost_json: string): boolean;

export function keypair(): Keys;

/**
 * Run a self-test of the encryption round-trip.
 * Returns true if all tests pass.
 */
export function self_test(): boolean;

export function start(): void;

export function test_zk_keys(): boolean;

export function validate_recovery_string(input: string): boolean;

/**
 * Verify a WernPost's content integrity without decrypting.
 * Useful for quick tamper-detection in the feed.
 *
 * Returns true if the content_hash matches the stored proof.
 */
export function verify_WernPost_integrity(WernPost_json: string, master_key_hex: string, user_id: string): boolean;

export function verify_identity_proof(proof_hex: string, public_inputs_js: Array<any>): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_ironcladidentityresult_free: (a: number, b: number) => void;
    readonly __wbg_ironcladsecurity_free: (a: number, b: number) => void;
    readonly __wbg_loginproofresult_free: (a: number, b: number) => void;
    readonly __wbg_securecallengine_free: (a: number, b: number) => void;
    readonly __wbg_webrtcexample_free: (a: number, b: number) => void;
    readonly bytes_to_hex: (a: any) => [number, number];
    readonly create_ephemeral_payload: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly create_secure_identity: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly decrypt_WernPost: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly decrypt_WernPost_field: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly decrypt_WernPosts_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly decrypt_display_blob: (a: any, b: any) => [number, number, number];
    readonly decrypt_display_fields: (a: any, b: any) => [number, number, number, number];
    readonly decrypt_signaling_message: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly decrypt_user_identity: (a: number, b: number, c: any, d: any, e: any) => [number, number, number, number];
    readonly derive_WernPost_master_key: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encrypt_WernPost: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly encrypt_WernPost_field: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number, number];
    readonly encrypt_display_blob: (a: any) => [number, number, number];
    readonly encrypt_display_field: (a: number, b: number) => [number, number, number];
    readonly encrypt_signaling_message: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly generate_WernPost_master_key: () => [number, number, number, number];
    readonly generate_WernPost_proof: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly generate_kyber_keypair: () => [number, number, number];
    readonly generate_login_proof: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint) => [number, number, number];
    readonly generate_recovery_string_js: () => [number, number, number, number];
    readonly get_commitment: (a: number, b: number) => [number, number, number, number];
    readonly get_encryption_version: (a: number, b: number) => number;
    readonly ironcladidentityresult_commitment: (a: number) => any;
    readonly ironcladidentityresult_encrypted_blob: (a: number) => any;
    readonly ironcladidentityresult_iv: (a: number) => any;
    readonly ironcladidentityresult_proof: (a: number) => any;
    readonly ironcladidentityresult_salt: (a: number) => any;
    readonly ironcladsecurity_clear_all_sessions: (a: number) => void;
    readonly ironcladsecurity_clear_session: (a: number, b: number, c: number) => void;
    readonly ironcladsecurity_decrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly ironcladsecurity_decrypt_ephemeral: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly ironcladsecurity_derive_master_key: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly ironcladsecurity_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly ironcladsecurity_encrypt_ephemeral: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: bigint, k: number, l: number) => [number, number, number, number];
    readonly ironcladsecurity_ephemeral_acknowledge_destruction: (a: number, b: number, c: number) => [number, number];
    readonly ironcladsecurity_ephemeral_attempt_view: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly ironcladsecurity_ephemeral_cleanup_expired: (a: number, b: number) => [number, number, number];
    readonly ironcladsecurity_ephemeral_is_destroyed: (a: number, b: number, c: number) => number;
    readonly ironcladsecurity_ephemeral_register: (a: number, b: number, c: number, d: any) => [number, number];
    readonly ironcladsecurity_ephemeral_remote_wipe: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly ironcladsecurity_ephemeral_report_screenshot: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly ironcladsecurity_establish_session: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly ironcladsecurity_generate_key: (a: number) => [number, number];
    readonly ironcladsecurity_generate_nonce: (a: number) => [number, number];
    readonly ironcladsecurity_generate_salt: (a: number) => [number, number];
    readonly ironcladsecurity_generate_wipe_token: (a: number) => [number, number];
    readonly ironcladsecurity_get_session_index: (a: number, b: number, c: number) => [number, bigint];
    readonly ironcladsecurity_has_session: (a: number, b: number, c: number) => number;
    readonly ironcladsecurity_new: () => number;
    readonly ironcladsecurity_security_checklist: (a: number) => any;
    readonly ironcladsecurity_validate_file_size: (a: number, b: number) => [number, number];
    readonly ironcladsecurity_validate_pin: (a: number, b: number, c: number) => [number, number];
    readonly ironcladsecurity_validate_recording_time: (a: number, b: number) => [number, number];
    readonly is_WernPost_encrypted: (a: number, b: number) => number;
    readonly loginproofresult_nullifier: (a: number) => [number, number];
    readonly loginproofresult_proof_hex: (a: number) => [number, number];
    readonly securecallengine_decrypt_rtp: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly securecallengine_encrypt_rtp: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number, number];
    readonly securecallengine_end_call: (a: number, b: number, c: number) => [number, number];
    readonly securecallengine_get_call_stats: (a: number, b: number, c: number) => [number, number, number];
    readonly securecallengine_get_proxy_chain_info: (a: number, b: number, c: number) => [number, number, number];
    readonly securecallengine_get_security_info: (a: number) => any;
    readonly securecallengine_init_secure_call: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly securecallengine_new: (a: any) => number;
    readonly securecallengine_trigger_kill_switch: (a: number, b: number, c: number) => [number, number];
    readonly self_test: () => number;
    readonly test_zk_keys: () => [number, number, number];
    readonly validate_recovery_string: (a: number, b: number) => number;
    readonly verify_WernPost_integrity: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly verify_identity_proof: (a: number, b: number, c: any) => [number, number, number];
    readonly webrtcexample_example_encrypt_decrypt: (a: number, b: number, c: number) => [number, number, number];
    readonly webrtcexample_new: () => number;
    readonly __wbg_get_params_ciphertextBytes: (a: number) => number;
    readonly __wbg_get_params_publicKeyBytes: (a: number) => number;
    readonly __wbg_get_params_secretKeyBytes: (a: number) => number;
    readonly __wbg_get_params_sharedSecretBytes: (a: number) => number;
    readonly __wbg_kex_free: (a: number, b: number) => void;
    readonly __wbg_params_free: (a: number, b: number) => void;
    readonly decapsulate: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encapsulate: (a: number, b: number) => [number, number, number];
    readonly kex_ciphertext: (a: number) => [number, number];
    readonly kex_new: (a: number, b: number) => number;
    readonly kex_set_ciphertext: (a: number, b: number, c: number) => void;
    readonly kex_set_sharedSecret: (a: number, b: number, c: number) => void;
    readonly kex_sharedSecret: (a: number) => [number, number];
    readonly keypair: () => [number, number, number];
    readonly params_ciphertextBytes: () => number;
    readonly params_publicKeyBytes: () => number;
    readonly params_secretKeyBytes: () => number;
    readonly params_sharedSecretBytes: () => number;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly start: () => void;
    readonly keys_new: () => [number, number, number];
    readonly __wbg_keys_free: (a: number, b: number) => void;
    readonly keys_pubkey: (a: number) => [number, number];
    readonly keys_secret: (a: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
