const { getBrowser } = require('../app/lib/browser');
const { sleep } = require('../app/lib/util');

(async () => {
  const b = getBrowser();
  const { cdp, tabId } = await b.open('http://127.0.0.1:8799/?provider=moviebox-cncverse&q=inception');
  try {
    let status = '';
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      status = await cdp.eval('document.querySelector("#status")?.textContent || ""').catch(() => '');
      if (status && !/connecting/i.test(status)) break;
    }
    console.log('status:', status);
    const tabs = await cdp.eval('document.querySelectorAll("#tabs button").length');
    console.log('tabs:', tabs);
    let cards = 0;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      cards = await cdp.eval('document.querySelectorAll(".card").length').catch(() => 0);
      const err = await cdp.eval('document.querySelector("#errors")?.textContent || ""').catch(() => '');
      if (err) throw new Error('ui error: ' + err);
      if (cards) break;
    }
    console.log('cards:', cards);
    if (!cards) throw new Error('no cards rendered');
    await cdp.eval('document.querySelector(".card").click()');
    let title = '';
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      title = await cdp.eval('document.querySelector("#detail h2")?.textContent || ""').catch(() => '');
      if (title) break;
    }
    console.log('detail:', title);
    if (!title) throw new Error('detail did not render');
    const buttons = await cdp.eval('[...document.querySelectorAll("#detail button")].map(b => b.textContent.trim())');
    console.log('buttons:', JSON.stringify(buttons));
    const err = await cdp.eval('document.querySelector("#errors")?.textContent || ""');
    if (err) throw new Error('ui error after detail: ' + err);
  } finally {
    cdp.close();
    await b.closeTab(tabId);
    b.stop();
  }
})().catch(e => { console.error('UI TEST FAILED:', e.message); process.exit(1); });
