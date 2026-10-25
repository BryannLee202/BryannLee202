// Cập nhật mục "Recent Activity" trong README.md từ GitHub API.
// - Lấy cả PushEvent (commit) kèm commit message thật.
// - Nếu có PROFILE_TOKEN (PAT) sẽ đọc được cả hoạt động ở repo private (được ẩn tên).
// - Thống kê commit chính xác qua GraphQL contributionsCollection.
// Chỉ ghi file khi nội dung thực sự thay đổi.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const USER = process.env.GH_USER || 'BryannLee202';
const TOKEN = process.env.PROFILE_TOKEN || process.env.GITHUB_TOKEN || '';
const MAX_LINES = Number(process.env.MAX_LINES || 10);
const README = 'README.md';
const START = '<!--START_SECTION:activity-->';
const END = '<!--END_SECTION:activity-->';
const TZ = 'Asia/Ho_Chi_Minh';

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': `${USER}-profile-activity`,
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function graphql(query, variables) {
  if (!TOKEN) return null;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const fmtTime = (iso) =>
  new Intl.DateTimeFormat('vi-VN', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
  }).format(new Date(iso));

const esc = (s) => s.replace(/[\\`*_|<>\[\]]/g, (c) => `\\${c}`);
const firstLine = (msg = '') => {
  const line = msg.split('\n')[0].trim();
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
};
const repoLink = (name) => `[${name}](https://github.com/${name})`;

const commitCache = new Map();
async function commitMessage(repo, sha) {
  const key = `${repo}@${sha}`;
  if (commitCache.has(key)) return commitCache.get(key);
  let msg = '';
  try {
    msg = firstLine((await gh(`/repos/${repo}/commits/${sha}`)).commit.message);
  } catch { /* commit có thể đã bị force-push xoá */ }
  commitCache.set(key, msg);
  return msg;
}

async function describe(e) {
  const repo = e.repo.name;
  const p = e.payload || {};
  const isPrivate = e.public === false;
  const where = isPrivate ? '🔒 *private repo*' : repoLink(repo);

  switch (e.type) {
    case 'PushEvent': {
      const branch = (p.ref || '').replace('refs/heads/', '');
      if (isPrivate) return `🔨 Pushed commits to ${where}`;
      const msg = p.head ? await commitMessage(repo, p.head) : '';
      const link = p.head ? ` ([\`${p.head.slice(0, 7)}\`](https://github.com/${repo}/commit/${p.head}))` : '';
      return `🔨 Pushed to ${where} \`${branch}\`${msg ? `: ${esc(msg)}` : ''}${link}`;
    }
    case 'PullRequestEvent': {
      const pr = p.pull_request || {};
      const action = p.action === 'closed' ? (pr.merged ? 'Merged' : 'Closed') : p.action === 'opened' ? 'Opened' : null;
      if (!action) return null;
      const icon = { Merged: '🎉', Closed: '❌', Opened: '💪' }[action];
      const num = pr.number ?? p.number;
      return isPrivate
        ? `${icon} ${action} a PR in ${where}`
        : `${icon} ${action} PR [#${num}](https://github.com/${repo}/pull/${num}) in ${where}`;
    }
    case 'IssuesEvent': {
      if (!['opened', 'closed'].includes(p.action)) return null;
      const num = p.issue?.number;
      const verb = p.action === 'opened' ? 'Opened' : 'Closed';
      const icon = p.action === 'opened' ? '❗' : '✔️';
      return isPrivate
        ? `${icon} ${verb} an issue in ${where}`
        : `${icon} ${verb} issue [#${num}](https://github.com/${repo}/issues/${num}) in ${where}`;
    }
    case 'IssueCommentEvent': {
      const num = p.issue?.number;
      return isPrivate
        ? `🗣 Commented in ${where}`
        : `🗣 Commented on [#${num}](${p.comment?.html_url}) in ${where}`;
    }
    case 'PullRequestReviewEvent': {
      const num = p.pull_request?.number;
      return isPrivate
        ? `👀 Reviewed a PR in ${where}`
        : `👀 Reviewed PR [#${num}](https://github.com/${repo}/pull/${num}) in ${where}`;
    }
    case 'CreateEvent':
      if (p.ref_type === 'repository') return `✨ Created repository ${where}`;
      if (p.ref_type === 'branch') return `🌿 Created branch \`${p.ref}\` in ${where}`;
      return null;
    case 'ReleaseEvent':
      return `🚀 Released \`${p.release?.tag_name}\` in ${where}`;
    case 'ForkEvent':
      return `🍴 Forked ${where}`;
    case 'WatchEvent':
      return `⭐ Starred ${where}`;
    case 'PublicEvent':
      return `📢 Made ${where} public`;
    default:
      return null;
  }
}

async function main() {
  // Endpoint /users/:user/events trả về cả private events khi token thuộc chính user đó.
  const events = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await gh(`/users/${USER}/events?per_page=100&page=${page}`);
    events.push(...batch);
    if (batch.length < 100) break;
  }
  events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const lines = [];
  for (const e of events) {
    if (e.repo.name === `${USER}/${USER}`) continue; // bỏ commit tự động của chính repo profile
    const text = await describe(e);
    if (!text) continue;
    lines.push(`| ${fmtTime(e.created_at)} | ${text} |`);
    if (lines.length >= MAX_LINES) break;
  }

  // Thống kê commit chính xác qua GraphQL (có tính cả private nếu dùng PAT)
  let stats = '';
  try {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 864e5);
    const data = await graphql(
      `query($login:String!,$from:DateTime!,$to:DateTime!){
        user(login:$login){
          week: contributionsCollection(from:$from,to:$to){ totalCommitContributions }
          year: contributionsCollection{ totalCommitContributions restrictedContributionsCount contributionCalendar{ totalContributions } }
        }
      }`,
      { login: USER, from: weekAgo.toISOString(), to: now.toISOString() },
    );
    if (data?.user) {
      const { week, year } = data.user;
      stats =
        `> 📈 **${week.totalCommitContributions}** commits trong 7 ngày qua` +
        ` · **${year.totalCommitContributions}** commits trong 12 tháng` +
        ` · **${year.contributionCalendar.totalContributions}** contributions` +
        (year.restrictedContributionsCount ? ` (gồm ${year.restrictedContributionsCount} private)` : '');
    }
  } catch (err) {
    console.warn('GraphQL stats skipped:', err.message);
  }

  const body = [
    ...(stats ? [stats, ''] : []),
    '| 🕒 Thời gian (GMT+7) | Hoạt động |',
    '| :--- | :--- |',
    ...(lines.length ? lines : ['| — | Chưa có hoạt động công khai gần đây |']),
  ].join('\n');

  const readme = readFileSync(README, 'utf8');
  const s = readme.indexOf(START);
  const t = readme.indexOf(END);
  if (s === -1 || t === -1) throw new Error('Activity markers not found in README.md');
  const next = `${readme.slice(0, s + START.length)}\n${body}\n${readme.slice(t)}`;

  const changed = next !== readme;
  if (changed) writeFileSync(README, next);
  console.log(changed ? 'README updated' : 'No changes');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
