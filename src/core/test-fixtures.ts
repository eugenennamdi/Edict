export const TOKENIZER_ADDRESS = "0x1111111111111111111111111111111111111111";
export const INVESTOR_ADDRESS = "0x2222222222222222222222222222222222222222";
export const GOLDEN_MANIFEST_CANONICAL =
  '{"asset":{"documentationUrl":"https://docs.example.com/asset?b=2&a=1","name":"Café Receivables","supplyCap":"1000","symbol":"ED1","tokenType":"RWA_TOKEN"},"chainId":"11155111","environment":"sandbox","investor":{"email":"investor@example.com","mintAmount":"25","walletAddress":"0x2222222222222222222222222222222222222222"},"schemaVersion":"1.0","tokenizer":{"email":"tokenizer@example.com","walletAddress":"0x1111111111111111111111111111111111111111"}}';
export const GOLDEN_MANIFEST_HASH =
  "sha256:e35ca81e3ace310cfd0405572e4ea62fd182a398045c7de416df021ae4ab51a1";
export const GOLDEN_PLAN_HASH =
  "sha256:4298e240bb62db3a807fd705d942ca81fe61612c6d2770bbb2809c4c6ce82740";

export function createValidRawManifest() {
  return {
    schemaVersion: "1.0",
    environment: "sandbox",
    chainId: "11155111",
    tokenizer: {
      email: "  TOKENIZER@EXAMPLE.COM ",
      walletAddress: "  0x1111111111111111111111111111111111111111 ",
    },
    asset: {
      name: "  Cafe\u0301\t Receivables  ",
      symbol: " ed1 ",
      tokenType: "RWA_TOKEN",
      supplyCap: "00001000",
      documentationUrl: " https://DOCS.example.com:443/asset?b=2&a=1 ",
    },
    investor: {
      email: " INVESTOR@EXAMPLE.COM ",
      walletAddress: " 0x2222222222222222222222222222222222222222 ",
      mintAmount: "00025",
    },
  };
}
