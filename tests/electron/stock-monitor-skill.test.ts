import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManagedSkillCatalog } from '../../services/local-ai-core/src/runtime/managed-skill-catalog.js';
import { composeAgentMessage } from '../../services/local-ai-core/src/thread/agent-message-policy.js';

const sourceSkillPath = join(process.cwd(), 'electron', 'managed-skills', 'stock-monitor', 'SKILL.md');

test('stock monitor skill defines comprehensive market formats, metrics, strategies, and CLI commands', () => {
  const content = readFileSync(sourceSkillPath, 'utf8');

  // Metadata frontmatter
  assert.match(content, /name:\s*stock-monitor/);
  assert.match(content, /description:/);
  assert.match(content, /allowed-tools:\s*Bash\(lac monitor:\*\)/);

  // Market ticker formats
  assert.match(content, /AAPL|NVDA|TSLA/); // US stocks
  assert.match(content, /00700|09988/); // HK stocks
  assert.match(content, /600519|000001|sh600519/); // A-shares

  // Metrics
  assert.match(content, /latestPrice/);
  assert.match(content, /change_percent/);
  assert.match(content, /abs_change_percent/);
  assert.match(content, /boll_lower/);
  assert.match(content, /boll_middle/);
  assert.match(content, /boll_upper/);
  assert.match(content, /boll_percent_b/);
  assert.match(content, /boll_signal/);
  assert.match(content, /dividend_yield/);
  assert.match(content, /annual_dividend/);
  assert.match(content, /erp_spread/);
  assert.match(content, /dividend_signal/);

  // Strategies & Conditions
  assert.match(content, /latestPrice\s*<=\s*boll_lower/);
  assert.match(content, /latestPrice\s*>=\s*boll_upper/);
  assert.match(content, /dividend_yield\s*>=\s*5\.0/);
  assert.match(content, /latestPrice\s*<=\s*boll_lower\s*&&\s*dividend_yield\s*>=\s*4\.0/);

  // CLI usage
  assert.match(content, /lac monitor add/);
  assert.match(content, /--source\s+stock\.quote/);
  assert.match(content, /lac monitor list/);
  assert.match(content, /lac monitor info/);
  assert.match(content, /lac monitor edit/);
  assert.match(content, /lac monitor del/);
  assert.match(content, /lac monitor run/);

  // Decision Workflow & Retrospective
  assert.match(content, /--workflow\s+deep-analysis/);
  assert.match(content, /--retro-delay\s+24h/);
  assert.match(content, /lac monitor decisions/);
  assert.match(content, /GROUNDED DATA CONTRACT/);
  assert.match(content, /多空博弈/);
});

test('managed skill catalog loads exact source stock-monitor skill', () => {
  const catalog = new ManagedSkillCatalog({ rootDir: join(process.cwd(), 'electron', 'managed-skills') });
  const source = catalog.get('stock-monitor');
  assert(source, 'stock-monitor skill should be found in catalog');
  assert.equal(source.scope, 'builtin');
  assert.equal(source.content, readFileSync(sourceSkillPath, 'utf8'));

  const skills = catalog.listSkills();
  const listed = skills.find((s) => s.id === 'stock-monitor');
  assert(listed, 'stock-monitor should be listed in listSkills');
  assert.equal(listed.scope, 'builtin');
  assert.equal(listed.name, 'stock-monitor');
  assert.equal(listed.enabled, true);
});

test('agent message policy injects stock-monitor skill when message is about stock watching or market queries', () => {
  const catalog = new ManagedSkillCatalog({ rootDir: join(process.cwd(), 'electron', 'managed-skills') });
  const stockSkill = catalog.get('stock-monitor');
  assert(stockSkill);

  // Chinese queries
  for (const query of [
    '你有哪些盯盘能力？',
    '帮我监控腾讯股票的价格和布林线',
    '设置茅台的股息率预警',
    '我想盯盘美股 AAPL',
    '有哪些股票监控功能',
    '帮我监控 600519 的行情异动',
  ]) {
    const message = composeAgentMessage(query, [], catalog);
    assert.match(message, /\[Stock Monitor Skill\]/, `Expected [Stock Monitor Skill] injected for "${query}"`);
    assert.match(message, /\[\/Stock Monitor Skill\]/);
  }

  // English queries
  for (const query of [
    'What stock monitoring capabilities do you have?',
    'Monitor AAPL stock with weekly bollinger bands',
    'Track dividend yield and price alert for ticker NVDA',
    'Set up a market watch alert for quotes',
  ]) {
    const message = composeAgentMessage(query, [], catalog);
    assert.match(message, /\[Stock Monitor Skill\]/, `Expected [Stock Monitor Skill] injected for "${query}"`);
  }

  // Non-stock queries should not inject stock-monitor skill
  for (const nonMatching of [
    'Schedule a reminder every day at noon.',
    'Explain how typescript interfaces work.',
    'Send a message to my teammate on slack.',
  ]) {
    const message = composeAgentMessage(nonMatching, [], catalog);
    assert.doesNotMatch(message, /\[Stock Monitor Skill\]/, `Did not expect [Stock Monitor Skill] for "${nonMatching}"`);
  }
});
