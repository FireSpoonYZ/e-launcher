// Run in the fixture's browser console:
// (await import('/test/tool-preview-check.js')).checkToolPreview()
export async function checkToolPreview() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.toolPreview.setOutput(null);
  window.toolPreview.setRunning(true);
  document.querySelectorAll('details.tool').forEach(card => { card.open = false; });
  await frame();
  const cards = [...document.querySelectorAll('details.tool')];
  check(cards.length === 3 && cards.every(card => !card.open), 'Initially collapsed');
  check(cards[1].querySelector('.tool-preview').innerText.includes('2064'), 'Collapsed result preview');
  check(getComputedStyle(cards[1].querySelector('.tool-preview')).display !== 'none', 'Visible preview');
  check(cards[2].innerText.includes('等待结果'), 'Waiting for result');
  cards[2].querySelector('summary').click();
  await frame();
  check(cards[2].open, 'Native disclosure opens');
  window.toolPreview.setOutput('<script>not executable</script>\nsecond\nthird\nfourth\n' + 'long'.repeat(150));
  await frame();
  check(cards[2] === document.querySelectorAll('details.tool')[2] && cards[2].open, 'Update retains open state');
  check(cards[2].innerText.includes('已返回'), 'Returned state');
  check([...cards[2].querySelectorAll('.tool-details pre')].at(-1).textContent.includes('fourth'), 'Full output retained');
  check(!cards[2].querySelector('script'), 'Output is plain text');
  cards[2].querySelector('summary').click();
  await frame();
  check(!cards[2].open, 'Disclosure closes');
  check(cards[2].querySelector('.tool-preview').textContent.split('\n').length === 3, 'Three preview lines');
  window.toolPreview.setPath('web/src/' + 'very-long-path/'.repeat(30) + 'Chat.tsx');
  await frame();
  check(document.documentElement.scrollWidth === window.innerWidth, 'No horizontal page overflow');
  window.toolPreview.setOutput(null);
  window.toolPreview.setRunning(false);
  await frame();
  check(cards[2].innerText.includes('无结果') && !cards[2].innerText.includes('等待结果'), 'Stopped calls do not keep waiting');
  window.toolPreview.setPath('web/src/Chat.tsx');
  window.toolPreview.setRunning(true);
  return {passed: 13, width: window.innerWidth, theme: document.documentElement.dataset.theme};
}
