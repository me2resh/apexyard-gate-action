// Production public key for the ApexYard pack signing key "apexyard-pack-1"
// (AWS KMS, ECC_NIST_P256, SIGN_VERIFY), read with kms:GetPublicKey on 2026-10-03.
// To rotate: add a new kid here before the producer signs with it.
export const PINNED_KEYS = {
  "apexyard-pack-1": `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEW+fgpyTNhUqcMNIMkgcgdHCHg/KI
pzGrwIheQy0uffLivS/mSogB70lfX0L48OHx6nSjbFMd+mSCEyGU/6e33Q==
-----END PUBLIC KEY-----
`,
};
