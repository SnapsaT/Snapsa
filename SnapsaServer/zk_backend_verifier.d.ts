/* tslint:disable */
/* eslint-disable */

export class IdentityVerifier {
  free(): void;
  [Symbol.dispose](): void;
  verify_identity(proof_hex: string, commitment_hex: string): boolean;
  constructor();
}

export class LoginVerifier {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  verify(proof_hex: string, commitment_hex: string, nullifier_hex: string, domain: string, epoch: bigint): boolean;
}
