import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationPageFollow } from '../src/conversation-page-follow.ts';

const viewportHeight = 800;
const visibleBottom = { top: 100, bottom: 760 };
const turn = (id) => ({ id });

test('mounting and the first history snapshot never move the page', () => {
  const follow = new ConversationPageFollow();
  assert.equal(follow.update([], visibleBottom, viewportHeight), 0);
  assert.equal(follow.update([turn('restored')], { top: 100, bottom: 1400 }, viewportHeight), 0);
});

test('an explicitly submitted first message follows only when the composer was nearby', () => {
  for (const [bounds, expectedOffset] of [[visibleBottom, 216], [{ top: 100, bottom: 1300 }, 0]]) {
    const follow = new ConversationPageFollow();
    follow.update([], bounds, viewportHeight);
    follow.followSubmittedTurn();
    assert.equal(follow.update([turn('first-message')], { top: 100, bottom: 1000 }, viewportHeight), expectedOffset);
  }
});

test('first-message submission intent does not survive a reset or hidden section', () => {
  for (const bounds of [visibleBottom, null]) {
    const follow = new ConversationPageFollow();
    follow.update([], visibleBottom, viewportHeight);
    follow.followSubmittedTurn();
    follow.update([], bounds, viewportHeight);
    assert.equal(follow.update([turn('restored')], { top: 100, bottom: 1400 }, viewportHeight), 0);
  }
});

test('new content follows the page and keeps the composer in view', () => {
  const follow = new ConversationPageFollow();
  follow.update([turn('one')], visibleBottom, viewportHeight);
  assert.equal(follow.update([turn('one'), turn('two')], { top: 100, bottom: 1000 }, viewportHeight), 216);
  assert.equal(follow.update([turn('one'), turn('two')], { top: 100, bottom: 880 }, viewportHeight), 96);
});

test('scrolling up to read history suspends follow until the bottom is approached again', () => {
  const follow = new ConversationPageFollow();
  follow.update([turn('one')], visibleBottom, viewportHeight);
  follow.observe({ top: 100, bottom: 1300 }, viewportHeight);
  assert.equal(follow.update([turn('one'), turn('two')], { top: 100, bottom: 1500 }, viewportHeight), 0);
  follow.observe({ top: -700, bottom: 850 }, viewportHeight);
  assert.equal(follow.update([turn('one'), turn('two'), turn('three')], { top: -700, bottom: 1000 }, viewportHeight), 216);
});

test('content below or above the viewport does not opt the user into follow', () => {
  for (const bounds of [{ top: 1000, bottom: 1600 }, { top: -1200, bottom: -200 }]) {
    const follow = new ConversationPageFollow();
    follow.update([turn('one')], bounds, viewportHeight);
    assert.equal(follow.update([turn('one'), turn('two')], { top: 100, bottom: 1000 }, viewportHeight), 0);
  }
});

test('hidden sections and mobile trace establish a baseline when shown again', () => {
  const follow = new ConversationPageFollow();
  const first = [turn('one')];
  follow.update(first, visibleBottom, viewportHeight);
  assert.equal(follow.update(first, null, viewportHeight), 0);
  const updated = [turn('one'), turn('two')];
  assert.equal(follow.update(updated, null, viewportHeight), 0);
  assert.equal(follow.update(updated, { top: 100, bottom: 1200 }, viewportHeight), 0);
  assert.equal(follow.update([...updated, turn('three')], { top: 100, bottom: 1400 }, viewportHeight), 0);
});

test('clearing, replacing or truncating history never jumps to the new bottom', () => {
  for (const next of [[], [turn('new-call')], [turn('one')]]) {
    const follow = new ConversationPageFollow();
    follow.update([turn('one'), turn('two')], visibleBottom, viewportHeight);
    assert.equal(follow.update(next, { top: 100, bottom: 1200 }, viewportHeight), 0);
  }
});

test('a layout-only change and content that already fits never move the page', () => {
  const follow = new ConversationPageFollow();
  const initial = [turn('one')];
  follow.update(initial, visibleBottom, viewportHeight);
  assert.equal(follow.update(initial, { top: 100, bottom: 1000 }, viewportHeight), 0);
  follow.observe(visibleBottom, viewportHeight);
  assert.equal(follow.update([...initial, turn('two')], { top: 100, bottom: 795 }, viewportHeight), 0);
});
