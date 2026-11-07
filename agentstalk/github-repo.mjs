/** Accept GitHub HTTPS, SSH and SCP remotes, never lookalike hostnames. */
export function githubRepoFromRemote(remote) {
  let url;
  try {
    url = new URL(remote.replace(/^git@github\.com:/, 'ssh://git@github.com/'));
  } catch { return undefined; }
  if (url.hostname.toLowerCase() !== 'github.com' || !['https:', 'ssh:'].includes(url.protocol)) return undefined;
  const match = /^\/([\w.-]+)\/([\w.-]+?)\/?$/.exec(url.pathname.replace(/\.git\/?$/, ''));
  return match ? `${match[1]}/${match[2]}` : undefined;
}
