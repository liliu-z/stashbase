import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const REPO = 'liliu-z/stashbase';
export function github(route, data) {
  return JSON.parse(execFileSync('gh', ['api', route, ...(data ? ['--method', 'POST', '--input', '-'] : [])], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    ...(data ? { input: JSON.stringify(data) } : {}),
  }));
}
export function tagVersion(tag) {
  if (!/^v[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) throw new Error('Expected a stable vX.Y.Z tag');
  return tag.slice(1);
}
export function resolveRelease(input) {
  if (input) tagVersion(input);
  const release = github(`repos/${REPO}/releases/${input ? `tags/${input}` : 'latest'}`);
  tagVersion(release.tag_name);
  if (release.draft || release.prerelease) throw new Error('Expected a public stable release');
  const sha = github(`repos/${REPO}/commits/${release.tag_name}`).sha;
  return { release, sha, version: tagVersion(release.tag_name) };
}
export function saveReport(file, report) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const clean = value => String(value).replace(/[|\r\n<>]/g, ' ');
  const rows = Object.entries(report.channels).map(([name, item]) => `| ${clean(name)} | ${clean(item.state)} | ${clean(item.detail)} |`);
  const markdown = `## Release channels: ${report.tag}\n\n| Channel | State | Evidence |\n| --- | --- | --- |\n${rows.join('\n')}\n\nPending is not published. Installed-app update journeys are separate checks.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
}
