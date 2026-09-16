// Build guard: refuse to build while `dev link` has a working copy of an api\ package junctioned into node_modules.
// A build made that way would ship whatever the working copy holds instead of the version the lockfile pins.
// State file: .dev-links.json at the workshop root — { "<project>": { "<pkg>": "api/<pkg>" } }, written by dev link, removed by dev unlink.
const fs = require('fs');
const path = require('path');

const links = path.join('C:\\Dev', '.dev-links.json');
const me = path.basename(path.resolve(__dirname, '..'));
if (fs.existsSync(links)) {
  const active = Object.keys((JSON.parse(fs.readFileSync(links, 'utf8'))[me]) || {});
  if (active.length) {
    console.error(`refusing to build ${me}: linked packages active (${active.join(', ')}) - run: dev unlink ${active[0]} --from ${me}`);
    process.exit(1);
  }
}
