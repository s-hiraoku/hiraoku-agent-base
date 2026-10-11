// Test-only offline JWKS response. Never loads installed credentials.
import process from "node:process";
globalThis.fetch = async (url, options) => {
  if (
    url !== "https://fixture.us.auth0.com/.well-known/jwks.json" ||
    options.redirect !== "error"
  )
    throw Error("unexpected_fixture_egress");
  return Response.json({ keys: [JSON.parse(process.env.HAB_TEST_PUBLIC_JWK)] });
};
