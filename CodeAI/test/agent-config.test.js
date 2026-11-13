const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { agentProfiles, agentSkills, agentMetadata, defaultSkillsFor } = require('../agent-config');

test('every selectable agent has a prompt, icon, description and valid skill preset', () => {
  assert.deepEqual(Object.keys(agentMetadata).sort(), Object.keys(agentProfiles).sort());
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  for (const [agentId, profile] of Object.entries(agentMetadata)) {
    assert.match(profile.icon, /^i-agent-[a-z-]+$/);
    assert.ok(profile.description);
    assert.ok(profile.skills.length > 0);
    assert.ok(profile.skills.every(skill => Object.hasOwn(agentSkills, skill)), agentId);
    assert.ok(html.includes(`<symbol id="${profile.icon}"`), `Missing icon for ${agentId}`);
  }
});

test('recommended skills are returned as a fresh list and unknown agents use developer defaults', () => {
  const first = defaultSkillsFor('debugger');
  first.push('custom');

  assert.deepEqual(defaultSkillsFor('debugger'), ['debug', 'tests']);
  assert.deepEqual(defaultSkillsFor('unknown'), defaultSkillsFor('developer'));
});
