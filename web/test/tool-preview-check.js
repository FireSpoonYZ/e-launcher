// Run in the fixture's browser console:
// (await import('/test/tool-preview-check.js')).checkToolPreview()
// Or from the repo: node scripts/check-tool-details.mjs
export async function checkToolPreview() {
  let passed = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); passed += 1; };
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const waitFor = async (ready, message) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (ready()) return;
      await frame();
    }
    check(ready(), message);
  };
  const installClipboard = () => {
    let copied = '';
    const writeText = async value => { copied = value; };
    try {
      Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
    } catch {
      navigator.clipboard.writeText = writeText;
    }
    return () => copied;
  };
  const readCopied = installClipboard();
  const copyOf = async pre => {
    pre.closest('.tool-block').querySelector('.tool-block-actions [aria-label="复制"]').click();
    await frame();
    return readCopied();
  };

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

  const resultCard = cards[2];
  resultCard.open = true;
  window.toolPreview.setOutput('ok');
  const resultPre = () => [...resultCard.querySelectorAll('.tool-details pre')].at(-1);
  await waitFor(() => resultPre()?.textContent === 'ok' && !resultCard.querySelector('.tool-fullscreen'), 'Short result settles');
  const shortPre = resultPre();
  check(shortPre.scrollHeight <= shortPre.clientHeight + 1, `Short result scrolls (${shortPre.scrollHeight}/${shortPre.clientHeight})`);
  check(getComputedStyle(shortPre).overflowY === 'hidden', 'Short result has no vertical scroll');
  check(!shortPre.classList.contains('is-overflow') && !resultCard.querySelector('.tool-fullscreen'), 'Short result has no fullscreen control');
  check(await copyOf(shortPre) === 'ok', 'Short copy keeps the original text');
  shortPre.click();
  await frame();
  check(resultCard.open && !document.querySelector('[role="dialog"]'), 'Text click does not expand or open the reader');

  const wide = 'z'.repeat(20000);
  const longText = `${wide}\n${'line\n'.repeat(Math.ceil(window.innerHeight) + 40)}`;
  window.toolPreview.setOutput(longText);
  await waitFor(() => resultPre()?.classList.contains('is-overflow') && resultCard.querySelector('.tool-fullscreen'), 'Long result shows fullscreen');
  const longPre = resultPre();
  const longStyle = getComputedStyle(longPre);
  check(longStyle.whiteSpace === 'pre-wrap' && longStyle.overflowWrap === 'anywhere', 'Long result wraps');
  check(longPre.scrollWidth <= longPre.clientWidth + 1, `No horizontal result overflow ${longPre.scrollWidth}>${longPre.clientWidth}`);
  check(longPre.scrollHeight > longPre.clientHeight + 1, 'Long result overflows vertically');
  const resultBlock = longPre.closest('.tool-block');
  check(resultBlock.clientHeight <= window.innerHeight / 2 + 4, `Result cap ${resultBlock.clientHeight} vs ${window.innerHeight}`);
  check(longPre.clientHeight < resultBlock.clientHeight, 'Title sits inside the cap and outside the text');
  check(longStyle.overflowY === 'auto', 'Overflow result scrolls vertically');
  const bar = longPre.closest('.tool-block').querySelector('.tool-block-bar');
  check(!longPre.contains(bar) && bar.querySelector('.tool-fullscreen') && bar.querySelector('[aria-label="复制"]'), 'Title, fullscreen and copy sit outside the scroller');
  const barTop = bar.getBoundingClientRect().top;
  longPre.scrollTop = longPre.scrollHeight;
  check(Math.abs(bar.getBoundingClientRect().top - barTop) < 1, 'Scrolling text leaves the title in place');
  check(await copyOf(longPre) === longText, 'Copy keeps the unwrapped original');
  check(document.documentElement.scrollWidth <= window.innerWidth + 1, 'Long result does not widen the page');

  const messages = document.querySelector('.messages');
  resultCard.querySelector('.tool-fullscreen').scrollIntoView({block: 'nearest'});
  const scrollBefore = messages.scrollTop;
  resultCard.querySelector('.tool-fullscreen').click();
  await waitFor(() => document.querySelector('[role="dialog"] .tool-reader-text'), 'Reader opens');
  const dialog = document.querySelector('[role="dialog"]');
  const reader = dialog.querySelector('.tool-reader-text');
  const header = dialog.querySelector('.dialog-header');
  const readerStyle = getComputedStyle(reader);
  check(reader.textContent === longText, 'Reader shows the original text');
  check(readerStyle.whiteSpace === 'pre-wrap' && readerStyle.overflowWrap === 'anywhere', 'Reader wraps');
  check(reader.scrollWidth <= reader.clientWidth + 1, `Reader has no horizontal overflow ${reader.scrollWidth}>${reader.clientWidth}`);
  check(reader.scrollHeight > reader.clientHeight, 'Reader scrolls vertically');
  check(header.querySelector('[aria-label="复制"]') && header.querySelector('[aria-label="关闭"]') && !reader.contains(header), 'Reader title row stays outside the text');
  check(getComputedStyle(dialog).position === 'fixed', 'Reader covers the page instead of growing the chat');
  check(messages.scrollTop === scrollBefore, 'Opening the reader keeps the chat position');
  header.querySelector('[aria-label="复制"]').click();
  await frame();
  check(readCopied() === longText, 'Reader copy keeps the original text');
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'Escape closes the reader');
  check(resultCard.open && messages.scrollTop === scrollBefore, 'Escape returns to the same chat position');
  await waitFor(() => document.activeElement === resultCard.querySelector('.tool-fullscreen'), 'Escape restores focus');

  resultCard.querySelector('.tool-fullscreen').click();
  await waitFor(() => document.querySelector('[role="dialog"]'), 'Reader reopens');
  if (!window.dispatchEvent(new Event('composer-back', {cancelable: true}))) throw new Error('composer-back was cancelled');
  if (document.querySelector('[role="dialog"]')) document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'Android back closes the reader');
  check(resultCard.open, 'Android back does not leave the chat');
  await waitFor(() => document.activeElement === resultCard.querySelector('.tool-fullscreen'), 'Back restores focus');

  resultCard.querySelector('.tool-fullscreen').click();
  await waitFor(() => document.querySelector('[role="dialog"] [aria-label="关闭"]'), 'Close control is present');
  navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); };
  document.querySelector('[role="dialog"] [aria-label="复制"]').click();
  await waitFor(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent.includes('Clipboard denied'), 'Reader exposes clipboard failure');
  check(document.querySelector('[role="dialog"] [role="alert"]').getBoundingClientRect().height > 0, 'Copy failure is visible in the reader');
  document.querySelector('[role="dialog"] [aria-label="关闭"]').click();
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'Close button dismisses the reader');
  check(messages.scrollTop === scrollBefore, 'Close keeps the chat position');
  await waitFor(() => document.activeElement === resultCard.querySelector('.tool-fullscreen'), 'Close restores focus');
  const clipboardAfterFailure = installClipboard();

  window.toolPreview.setOutput('ok');
  await waitFor(() => resultPre()?.textContent === 'ok' && !resultCard.querySelector('.tool-fullscreen'), 'Fullscreen control leaves with the overflow');
  check(!resultPre().classList.contains('is-overflow'), 'Short result drops the scroll class');

  const argumentCard = cards[0];
  argumentCard.open = true;
  const longPath = `web/src/${'very-long-path-segment/'.repeat(80)}Chat.tsx`;
  window.toolPreview.setPath(longPath);
  const argumentPre = () => argumentCard.querySelector('.tool-details pre');
  await waitFor(() => argumentPre()?.textContent?.includes('very-long-path-segment'), 'Long arguments render');
  const argsPre = argumentPre();
  const argsStyle = getComputedStyle(argsPre);
  check(argsStyle.whiteSpace === 'pre-wrap' && argsStyle.overflowWrap === 'anywhere', 'Arguments wrap');
  check(argsPre.scrollWidth <= argsPre.clientWidth + 1, `No horizontal argument overflow ${argsPre.scrollWidth}>${argsPre.clientWidth}`);
  check(Boolean(argumentCard.querySelector('.tool-fullscreen')) === argsPre.classList.contains('is-overflow'), 'Argument fullscreen matches measured overflow');
  check(!argsPre.textContent.includes('\n'), 'Argument copy source is still the original line');
  await copyOf(argsPre);
  check(clipboardAfterFailure() === argsPre.textContent, 'Argument copy keeps the original JSON');
  window.toolPreview.setPath('web/src/Chat.tsx');
  window.toolPreview.setOutput(null);
  window.toolPreview.setRunning(true);
  argumentCard.open = false;
  resultCard.open = false;
  return {passed, width: window.innerWidth, height: window.innerHeight, theme: document.documentElement.dataset.theme};
}
