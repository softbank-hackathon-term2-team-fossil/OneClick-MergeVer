import "server-only";

import sodium from "libsodium-wrappers";
import type { Octokit } from "octokit";

async function encryptSecret(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const encrypted = sodium.crypto_box_seal(sodium.from_string(value), key);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

export async function setRepositorySecret(
  client: Octokit,
  owner: string,
  repo: string,
  name: string,
  value: string,
): Promise<void> {
  const { data: publicKey } = await client.rest.actions.getRepoPublicKey({ owner, repo });
  const encryptedValue = await encryptSecret(value, publicKey.key);
  await client.rest.actions.createOrUpdateRepoSecret({
    owner,
    repo,
    secret_name: name,
    encrypted_value: encryptedValue,
    key_id: publicKey.key_id,
  });
}
