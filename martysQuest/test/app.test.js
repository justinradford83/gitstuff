/* End-to-end checks for the recovery tracker.
 *
 *   node test/app.test.js                 (from martysQuest/)
 *
 * Needs playwright-core and a Chromium. Point at them with
 * PW_MODULE and PW_CHROMIUM if they are not in the usual places.
 *
 * The clickEverything block is the one that matters most: a handler that
 * throws leaves a button doing nothing at all, with no visible error, and
 * that shipped twice — openCheckin and openStack were both deleted by a cut
 * that named neither. "Does this control respond" has to be asserted.
 */
/* playwright-core may not be installed next to this file; the remote container
   keeps one under /opt. */
const PW = process.env.PW_MODULE || (() => {
  for(const m of ['playwright-core', '/opt/node-tools/node_modules/playwright-core']){
    try { require.resolve(m); return m; } catch {}
  }
  throw new Error('no playwright-core found \u2014 set PW_MODULE to one');
})();
/* The bundled browser's build number rarely matches whatever playwright-core
   was installed last, so find a real binary rather than trusting the default. */
const CHROME = process.env.PW_CHROMIUM || (() => {
  const fs = require('fs');
  const roots = fs.existsSync('/opt/pw-browsers') ? fs.readdirSync('/opt/pw-browsers') : [];
  const candidates = roots.flatMap(d => [
    `/opt/pw-browsers/${d}/chrome-linux/chrome`,
    `/opt/pw-browsers/${d}/chrome-linux/headless_shell`,
    `/opt/pw-browsers/${d}/chrome-headless-shell-linux64/chrome-headless-shell`,
  ]);
  const found = candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; }
                                      catch { return false; } });
  if(!found) throw new Error('no Chromium found — set PW_CHROMIUM to one');
  return found;
})();
const { chromium } = require(PW);
const APP = 'file://' + require('path').resolve(__dirname, '..', 'index.html');

/* a fixed clock, so "today" and the evening nudge are deterministic */
const clock = (y,m,d,h=14,min=0) => `(()=>{const F=new Date(${y},${m},${d},${h},${min},0).getTime();
  const _D=Date; class X extends _D{constructor(...a){if(!a.length)super(F);else super(...a);}
  static now(){return F;}} window.Date=X;})()`;
const TODAY = [2026,9,11];

const settle = p => p.evaluate(()=>new Promise(res=>{ let last=-1, still=0;
  const tick=()=>{ const y=window.scrollY;
    if(y===last){ if(++still>6) return res(y); } else { still=0; last=y; }
    requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));

let pass=0; const fails=[];
const check=(ok,what)=>{ ok ? pass++ : fails.push(what); };

async function open(browser, {width=414, height=900, theme='dark', hour=14} = {}){
  const ctx = await browser.newContext({viewport:{width,height}, colorScheme:theme});
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e=>errs.push(String(e.message)));
  page.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); });
  await page.addInitScript(clock(...TODAY, hour));
  await page.goto(APP);
  await page.waitForTimeout(450);
  return {ctx, page, errs};
}
/* a fortnight of logging, so the most-logged row has something to rank */
const seed = page => page.evaluate(()=>{ const t=todayISO();
  const plan={mood:12, sleep:11, physiapp:8, nap:5, cardio:4, journal:3, coffee:9};
  let k=0; Object.entries(plan).forEach(([id,n])=>{ for(let i=0;i<n;i++)
    state.entries.push({uid:'seed'+(k++), date:addDays(t,-(i%14)), time:'09:00', id, q:1}); });
  save(); renderAll(); });

(async () => {
  const browser = await chromium.launch({executablePath: CHROME});

  /* ── every control responds ───────────────────────────────────────── */
  {
    const {ctx, page, errs} = await open(browser);
    await seed(page); await page.waitForTimeout(200);
    const press = async (sel, label) => {
      const before = errs.length;
      const found = await page.evaluate(s=>{ const e=document.querySelector(s); if(e){e.click();return true;} return false; }, sel);
      await page.waitForTimeout(130);
      const opened = await page.evaluate(()=>document.getElementById('sheet').classList.contains('on'));
      check(found && opened && errs.length===before, `${label} did nothing (found=${found} sheet=${opened} threw=${errs.length>before})`);
      await page.evaluate(()=>{ const c=document.querySelector('#sheet #cancel'); if(c) c.click();
        document.getElementById('sheet').classList.remove('on');
        document.getElementById('scrim').classList.remove('on'); });
      await page.waitForTimeout(70);
    };
    for(const st of await page.evaluate(()=>STACKS.map(s=>({id:s.id,label:s.label}))))
      await press(`[data-stack="${st.id}"]`, `stack "${st.label}"`);
    for(const id of await page.evaluate(()=>[...document.querySelectorAll('.freqchip')].map(c=>c.dataset.freq)))
      await press(`.freqchip[data-freq="${id}"]`, `most-logged chip ${id}`);
    const tiles = await page.evaluate(()=>[...document.querySelectorAll('#catalogGroups .tile')].map(t=>t.dataset.id));
    for(const id of tiles) await press(`.tile[data-id="${id}"]`, `tile ${id}`);
    console.log(`  controls: ${await page.evaluate(()=>STACKS.length)} stacks, ` +
      `${await page.evaluate(()=>document.querySelectorAll('.freqchip').length)} chips, ${tiles.length} tiles`);
    /* a stack must actually write rows */
    const n0 = await page.evaluate(()=>state.entries.length);
    await page.evaluate(()=>document.querySelector('[data-stack="morn"]').click());
    await page.waitForTimeout(200);
    await page.click('#sheet #ok'); await page.waitForTimeout(300);
    const added = await page.evaluate(()=>state.entries.length) - n0;
    const want  = await page.evaluate(()=>STACKS.find(s=>s.id==='morn').items.length);
    check(added===want, `morning stack logged ${added} rows, expected ${want}`);
    check(errs.length===0, `page errors: ${[...new Set(errs)].join(' | ')}`);
    await ctx.close();
  }

  /* ── jump bar: lands under the bar, lights the right chip ─────────── */
  for(const vp of [{width:414,height:900},{width:390,height:664},{width:360,height:780}]){
    const {ctx, page, errs} = await open(browser, vp);
    const ids = await page.evaluate(()=>[...document.querySelectorAll('#jumpbar [data-jump]')].map(b=>b.dataset.jump));
    const landed = async id => page.evaluate(j=>{
      const h=document.getElementById('grp-'+j).getBoundingClientRect();
      const b=document.getElementById('jumpbar').getBoundingClientRect();
      const lit=document.querySelector('#jumpbar button.on');
      return {gap:Math.round(h.top-b.bottom), lit:lit?lit.dataset.jump:null,
              chipInBar: lit ? (lit.getBoundingClientRect().left>=b.left-2 &&
                                lit.getBoundingClientRect().right<=b.right+2) : false};}, id);
    /* from the top, and from every other section — short hops included */
    for(const from of ['__top__', ...ids]){
      for(const to of ids){
        if(from===to) continue;
        await page.evaluate(()=>window.scrollTo({top:0, behavior:'instant'}));
        await page.waitForTimeout(40);
        if(from!=='__top__'){ await page.click(`#jumpbar [data-jump="${from}"]`); await settle(page); }
        await page.click(`#jumpbar [data-jump="${to}"]`); await settle(page);
        const r = await landed(to);
        check(Math.abs(r.gap-4)<=6, `[${vp.width}x${vp.height}] ${from}→${to}: heading ${r.gap}px from the bar`);
        check(r.lit===to,          `[${vp.width}x${vp.height}] ${from}→${to}: chip lit "${r.lit}"`);
        check(r.chipInBar,         `[${vp.width}x${vp.height}] ${from}→${to}: lit chip scrolled out of the bar`);
      }
    }
    /* and while scrolling by hand */
    const max = await page.evaluate(()=>document.scrollingElement.scrollHeight-window.innerHeight);
    for(let y=0; y<=max; y+=120){
      await page.evaluate(v=>window.scrollTo({top:v,behavior:'instant'}), y);
      await page.waitForTimeout(45);
      const r = await page.evaluate(()=>{
        const b=document.getElementById('jumpbar').getBoundingClientRect();
        const ids=[...document.querySelectorAll('#jumpbar [data-jump]')].map(x=>x.dataset.jump);
        let want=ids[0];
        for(const id of ids){ if(document.getElementById('sec-'+id).getBoundingClientRect().top<=b.bottom+6) want=id; else break; }
        const lit=document.querySelector('#jumpbar button.on');
        return {want, got:lit?lit.dataset.jump:null};});
      check(r.got===r.want, `[${vp.width}x${vp.height}] scrolled to ${y}: top section ${r.want}, chip ${r.got}`);
    }
    check(await page.evaluate(()=>document.documentElement.scrollWidth)<=vp.width,
      `[${vp.width}x${vp.height}] horizontal overflow`);
    check(errs.length===0, `[${vp.width}x${vp.height}] page errors: ${[...new Set(errs)].join(' | ')}`);
    await ctx.close();
  }

  /* ── the logging paths that earn dots ─────────────────────────────── */
  {
    const {ctx, page, errs} = await open(browser);
    const log = async (tile, qty, prep) => {
      if(prep) await prep();
      await page.evaluate(t=>document.querySelector(`.tile[data-id="${t}"]`).click(), tile);
      await page.waitForTimeout(200);
      if(qty!=null) await page.fill('#q', String(qty));
      await page.click('#sheet #ok'); await page.waitForTimeout(280);
    };
    await log('breathhold', 90);
    check(await page.evaluate(()=>dayMeta(todayISO()).dots.purple), 'breath hold did not earn SPIRITUAL');
    await log('sleep', 7.5);
    check(await page.evaluate(()=>dayMeta(todayISO()).dots.blue), 'sleep over 6h did not earn RECOVER');
    await log('physiapp', 1);
    check(await page.evaluate(()=>dayMeta(todayISO()).dots.green), 'PhysiApp alone did not earn REHAB');
    await log('rings', 3);
    check(await page.evaluate(()=>dayMeta(todayISO()).dots.red), 'rings workout alone did not earn STRENGTH');
    /* the mood picker is its own sheet */
    await page.evaluate(()=>document.querySelector('.tile[data-id="mood"]').click());
    await page.waitForTimeout(220);
    check(await page.evaluate(()=>document.querySelectorAll('#sheet .moodtile').length)===9, 'mood picker is not nine tiles');
    await page.click('#sheet .moodtile[data-m="6"]'); await page.waitForTimeout(100);
    await page.click('#sheet #ok'); await page.waitForTimeout(300);
    check(await page.evaluate(()=>state.daily[todayISO()].mood9)===6, 'mood did not store');
    /* re-checking replaces rather than stacks */
    await page.evaluate(()=>document.querySelector('.tile[data-id="mood"]').click());
    await page.waitForTimeout(200);
    await page.click('#sheet .moodtile[data-m="3"]'); await page.waitForTimeout(80);
    await page.click('#sheet #ok'); await page.waitForTimeout(280);
    check(await page.evaluate(()=>state.entries.filter(e=>e.id==='mood').length)===1, 'a second mood check stacked a row');
    check(errs.length===0, `logging page errors: ${[...new Set(errs)].join(' | ')}`);
    await ctx.close();
  }

  /* ── the evening nudge ────────────────────────────────────────────── */
  for(const [hour, want] of [[18,false],[19,true],[23,true]]){
    const {ctx, page} = await open(browser, {hour});
    const shown = await page.evaluate(()=>!document.getElementById('moodNudge').hidden);
    check(shown===want, `at ${hour}:00 with no mood logged the nudge was ${shown?'shown':'hidden'}`);
    await ctx.close();
  }
  { /* and it clears once the mood is in */
    const {ctx, page} = await open(browser, {hour:20});
    await page.evaluate(()=>{ state.daily[todayISO()]=Object.assign({},state.daily[todayISO()]||{},{mood9:6});
      save(); renderAll(); });
    await page.waitForTimeout(150);
    check(await page.evaluate(()=>document.getElementById('moodNudge').hidden), 'nudge stayed up after the mood was logged');
    await ctx.close();
  }

  /* ── the share link keeps the private things out of family mode ───── */
  {
    const {ctx, page} = await open(browser);
    await seed(page); await page.waitForTimeout(150);
    await page.evaluate(()=>{ state.daily[todayISO()] =
      Object.assign({}, state.daily[todayISO()]||{}, {mood9:8, note:'a private note'}); save(); });
    for(const [clinical, wantMood, wantNote] of [[true,true,true],[false,false,false]]){
      const link = await page.evaluate(c=>buildShareLink(c), clinical);
      const v = await ctx.newPage();
      await v.addInitScript(clock(...TODAY));
      await v.goto('file://'+require('path').resolve(__dirname,'..','share.html')+link.slice(link.indexOf('#')));
      await v.waitForTimeout(650);
      const hasMood = await v.evaluate(()=>Object.values(state.daily).some(d=>d.mood9!=null)
        || state.entries.some(e=>e.id==='mood'));
      const hasNote = await v.evaluate(()=>Object.values(state.daily).some(d=>d.note));
      check(hasMood===wantMood, `${clinical?'clinical':'family'} link: mood present=${hasMood}`);
      check(hasNote===wantNote, `${clinical?'clinical':'family'} link: notes present=${hasNote}`);
      await v.close();
    }
    await ctx.close();
  }

  /* ── the dashboard's metric cards ─────────────────────────────────── */
  {
    const {ctx, page, errs} = await open(browser);
    await page.evaluate(()=>{ const t=todayISO();
      [[1,95],[1,52],[5,78],[7,112],[14,55],[18,118],[24,122]].forEach(([d,sec],i)=>
        state.entries.push({uid:'bh'+i, date:addDays(t,-d), time:'08:00', id:'breathhold', q:sec}));
      [['rings'],['mace','hang'],['cardio'],['rings','paddle','mace']].forEach((items,i)=>
        items.forEach((id,j)=>state.entries.push({uid:'ft'+i+j, date:addDays(t,-(i*3)), time:'10:00', id, q:1})));
      save(); renderAll(); });
    await page.click('nav.tabs button[data-tab="dash"]');
    await page.waitForTimeout(350);
    /* the acute-phase readouts are gone */
    const txt = await page.evaluate(()=>document.getElementById('dashBody').innerText);
    for(const stale of ['Acetaminophen today','Opioid-free','Last acetaminophen','Days over ceiling'])
      check(!txt.includes(stale), `dashboard still shows "${stale}"`);
    check(!await page.evaluate(()=>!!document.querySelector('#dashBody svg[aria-label*="acetaminophen"]')),
      'the acetaminophen chart is still on the dashboard');
    /* both cards render with numbers and bars */
    const cards = await page.evaluate(()=>[...document.querySelectorAll('#dashBody .mcard')].map(c=>({
      title:c.querySelector('h3').textContent,
      stats:c.querySelectorAll('.mstat').length,
      bars:c.querySelectorAll('svg rect[rx]').length })));
    check(cards.length===2, `expected 2 metric cards, got ${cards.length}`);
    for(const c of cards){
      check(c.stats===2, `${c.title} card has ${c.stats} headline stats`);
      check(c.bars>0,   `${c.title} card drew no bars`);
    }
    /* each range switch changes the window and is remembered */
    for(const key of ['bh','str']){
      for(const d of [7,30,90,0]){
        await page.click(`#dashBody [data-${key}="${d}"]`);
        await page.waitForTimeout(170);
        const lit = await page.evaluate(k=>{
          const c=[...document.querySelectorAll('.mcard')].find(x=>x.querySelector(`[data-${k}]`));
          return c.querySelector('.seg button.on').dataset[k]; }, key);
        check(lit===String(d), `${key} range ${d}: lit chip says ${lit}`);
      }
    }
    check(await page.evaluate(()=>state.settings.bhRange)===0 &&
          await page.evaluate(()=>state.settings.strRange)===0, 'card ranges were not remembered');
    /* the ceiling guard stays quiet until the day actually runs at it */
    for(const [tabs, want] of [[0,false],[4,false],[7,true],[9,true]]){
      await page.evaluate(n=>{ const t=todayISO();
        state.entries = state.entries.filter(e=>!(e.date===t && e.id==='apap'));
        if(n) state.entries.push({uid:'ap', date:t, time:'09:00', id:'apap', q:n});
        save(); renderDash(); }, tabs);
      await page.waitForTimeout(140);
      const shown = await page.evaluate(()=>!!document.querySelector('.apapwarn'));
      check(shown===want, `at ${tabs*500} mg the ceiling warning was ${shown?'shown':'hidden'}`);
    }
    check(errs.length===0, `dashboard page errors: ${[...new Set(errs)].join(' | ')}`);
    await ctx.close();
  }

  /* ── storage key: changing it orphans the record on the phone ─────── */
  {
    const {ctx, page} = await open(browser);
    check(await page.evaluate(()=>KEY)==='mq_recovery_v3', 'the localStorage key changed');
    await ctx.close();
  }

  await browser.close();
  console.log(`\n${pass} checks passed` + (fails.length ? `, ${fails.length} FAILED:\n  - ` + fails.join('\n  - ') : '.'));
  process.exit(fails.length ? 1 : 0);
})();
