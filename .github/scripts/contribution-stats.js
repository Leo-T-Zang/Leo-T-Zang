// Collects every public, non-fork repo Leo-T-Zang has landed code in and
// writes a star summary into README.md between the CONTRIBUTION-STATS markers.
//
// A repo counts if ANY of these is true:
//   1. A PR authored by the user was merged into it (catches squash merges,
//      where the resulting commit is attributed to the merger).
//   2. The user has commit contributions in it in any year since the account
//      was created (catches direct pushes, e.g. lab repos like
//      programmablebio/pepmlm that never went through a PR).
//   3. The user owns it.
// Open or closed-without-merge PRs never count, since they produce neither a
// merged PR nor a commit contribution.

const fs = require('fs');

const LOGIN = 'Leo-T-Zang';

// Safety-net list of repos to exclude even if they qualify above. Use for
// trivial/typo-fix PRs you don't want to claim, or repos that landed in error.
const EXCLUDED_REPOS = new Set([
  'pytorch/torchtitan',
]);

const REPO_FIELDS = `
  nameWithOwner
  url
  description
  stargazerCount
  isFork
  isPrivate
  primaryLanguage { name }
`;

async function graphql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent': 'GitHub-Stats-Action',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.errors) throw new Error('GraphQL errors: ' + JSON.stringify(body.errors, null, 2));
  return body.data;
}

async function mergedPrRepos() {
  const repos = [];
  let after = null;
  do {
    const data = await graphql(`
      query($q: String!, $after: String) {
        search(query: $q, type: ISSUE, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ... on PullRequest { repository { ${REPO_FIELDS} } } }
        }
      }`, { q: `is:pr author:${LOGIN} is:merged is:public`, after });
    for (const pr of data.search.nodes) if (pr && pr.repository) repos.push(pr.repository);
    after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

// contributionsCollection spans at most one year, so walk year by year from
// account creation to now.
async function commitRepos(createdAt) {
  const repos = [];
  const now = new Date();
  for (let from = new Date(createdAt); from < now; ) {
    const to = new Date(from);
    to.setUTCFullYear(to.getUTCFullYear() + 1);
    const end = to < now ? to : now;
    const data = await graphql(`
      query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            commitContributionsByRepository(maxRepositories: 100) {
              repository { ${REPO_FIELDS} }
            }
          }
        }
      }`, { login: LOGIN, from: from.toISOString(), to: end.toISOString() });
    for (const c of data.user.contributionsCollection.commitContributionsByRepository) {
      repos.push(c.repository);
    }
    from = to;
  }
  return repos;
}

async function ownedRepos() {
  const repos = [];
  let after = null;
  do {
    const data = await graphql(`
      query($login: String!, $after: String) {
        user(login: $login) {
          repositories(first: 100, after: $after, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes { ${REPO_FIELDS} }
          }
        }
      }`, { login: LOGIN, after });
    const page = data.user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

function render(repos) {
  const totalStars = repos.reduce((sum, r) => sum + r.stargazerCount, 0);
  let md = `## ⭐ Total Stars from Code Contributions: ${totalStars}\n\n`;
  md += `*From ${repos.length} repositories with contributions*\n\n`;
  md += `### Top Contributed Repositories:\n\n`;
  for (const r of repos.slice(0, 10)) {
    md += `- [${r.nameWithOwner}](${r.url}) - ⭐ ${r.stargazerCount} stars`;
    if (r.primaryLanguage) md += ` (${r.primaryLanguage.name})`;
    md += '\n';
    if (r.description) md += `  - ${r.description}\n`;
  }
  return md;
}

async function main() {
  const { user } = await graphql(
    'query($login: String!) { user(login: $login) { createdAt } }', { login: LOGIN });

  const sources = {
    'merged PRs': await mergedPrRepos(),
    'commits': await commitRepos(user.createdAt),
    'owned': await ownedRepos(),
  };

  const seen = new Map();
  for (const [source, repos] of Object.entries(sources)) {
    console.log(`${source}: ${repos.length} repo hits`);
    for (const r of repos) if (!seen.has(r.nameWithOwner)) seen.set(r.nameWithOwner, r);
  }

  const repos = [...seen.values()].filter(r => {
    if (r.isFork || r.isPrivate || r.stargazerCount <= 0) return false;
    if (EXCLUDED_REPOS.has(r.nameWithOwner)) {
      console.log(`Excluding ${r.nameWithOwner} (in EXCLUDED_REPOS)`);
      return false;
    }
    return true;
  });
  repos.sort((a, b) => b.stargazerCount - a.stargazerCount);
  for (const r of repos) console.log(`  ${r.nameWithOwner}: ${r.stargazerCount}`);

  const startMarker = '<!-- CONTRIBUTION-STATS:START -->';
  const endMarker = '<!-- CONTRIBUTION-STATS:END -->';
  const readme = fs.readFileSync('README.md', 'utf8');
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);
  if (start === -1 || end === -1) throw new Error('Markers not found in README.md');

  fs.writeFileSync('README.md',
    readme.slice(0, start) + `${startMarker}\n${render(repos)}\n` + readme.slice(end));
  console.log('README updated successfully!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
