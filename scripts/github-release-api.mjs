export async function findDraftReleaseByTag({ request, repo, tag }) {
  const [owner, name, ...extra] = repo.split('/');
  if (!owner || !name || extra.length > 0) {
    throw new Error(`Invalid GitHub repository slug: ${repo}`);
  }
  const query = 'query RepositoryReleaseByTag($owner:String!,$name:String!,$tagName:String!){repository(owner:$owner,name:$name){release(tagName:$tagName){databaseId,isDraft}}}';
  const lookup = await request('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { owner, name, tagName: tag } }),
  });
  if (lookup?.errors?.length) {
    throw new Error(`GitHub GraphQL release lookup failed: ${JSON.stringify(lookup.errors)}`);
  }
  const reference = lookup?.data?.repository?.release;
  const existing = reference?.databaseId
    ? await request(`/repos/${repo}/releases/${reference.databaseId}`)
    : null;
  if (!existing) {
    throw new Error(`Draft release ${tag} does not exist. Start the coordinated Release workflow.`);
  }
  if (!reference.isDraft || !existing.draft) {
    throw new Error(`Release ${tag} must remain a draft while assets are uploaded.`);
  }
  return existing;
}
