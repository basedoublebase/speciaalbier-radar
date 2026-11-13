/* Openingstijden: kleine parser voor de OpenStreetMap opening_hours-notatie
   (de gangbare vormen zoals "Mo-Sa 07:00-21:00; Su 10:00-18:00; PH off" en "Tu-We 22:00-04:00").
   Feestdagen (PH) en uitzonderingen worden genegeerd. Tijden rekenen in Europe/Amsterdam. */
window.Hours = (() => {
  "use strict";
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const NL = ["ma", "di", "wo", "do", "vr", "za", "zo"];
  const DAY_RX = /^(Mo|Tu|We|Th|Fr|Sa|Su)(-(Mo|Tu|We|Th|Fr|Sa|Su))?$/;

  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const fmt = (min) => { min = ((min % 1440) + 1440) % 1440; return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0"); };

  /** Geeft week[0..6] (ma..zo) met [[start, eind], ...] in minuten, of null als het niet te lezen is. */
  function parse(str) {
    if (!str) return null;
    str = str.trim();
    if (str === "24/7") return DAYS.map(() => [[0, 1440]]);
    const week = DAYS.map(() => []);
    for (let rule of str.split(";")) {
      rule = rule.trim();
      if (!rule) continue;
      const m = rule.match(/^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?\s*)+)?\s*(.*)$/);
      if (!m) return null;
      const daysPart = (m[1] || "").replace(/\s+/g, "");
      const timePart = m[2].trim();
      let days = [];
      if (!daysPart) days = [0, 1, 2, 3, 4, 5, 6];
      else {
        for (const d of daysPart.split(",").filter(Boolean)) {
          if (d === "PH") continue;
          const dm = d.match(DAY_RX);
          if (!dm) return null;
          const a = DAYS.indexOf(dm[1]), b = dm[3] ? DAYS.indexOf(dm[3]) : a;
          for (let i = a; ; i = (i + 1) % 7) { days.push(i); if (i === b) break; }
        }
        if (!days.length) continue; // alleen PH-regel
      }
      let spans = [];
      if (/^(off|closed)$/i.test(timePart)) spans = [];
      else {
        for (const t of timePart.split(",")) {
          const tm = t.trim().match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
          if (!tm) return null;
          let s = toMin(tm[1]), e = toMin(tm[2]);
          if (e <= s) e += 1440; // over middernacht
          spans.push([s, e]);
        }
      }
      for (const d of days) week[d] = spans; // latere regels overschrijven eerdere
    }
    return week;
  }

  /** Huidige dag (0=ma) en minuten in Nederlandse tijd. */
  function nowNL(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
    return { day: DAYS.indexOf(parts.weekday.slice(0, 2)), min: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  /** {open: bool, until?: "21:00", opens?: "ma 08:00"} of null als onbekend. */
  function status(str, date) {
    const week = typeof str === "string" ? parse(str) : str;
    if (!week) return null;
    const { day, min } = nowNL(date);
    const prev = (day + 6) % 7;
    for (const [s, e] of week[prev]) if (e > 1440 && min < e - 1440) return { open: true, until: fmt(e) };
    for (const [s, e] of week[day]) if (min >= s && min < e) return { open: true, until: fmt(e) };
    for (let k = 0; k < 8; k++) {
      const d = (day + k) % 7;
      const spans = week[d].filter(([s]) => k > 0 || s > min).sort((a, b) => a[0] - b[0]);
      if (spans.length) return { open: false, opens: (k === 0 ? "vandaag" : k === 1 ? "morgen" : NL[d]) + " " + fmt(spans[0][0]) };
    }
    return { open: false };
  }

  /** Leesbaar weekoverzicht, bv. "ma–za 07:00–21:00 · zo 10:00–18:00". */
  function describe(str) {
    const week = parse(str);
    if (!week) return str || "";
    const txt = week.map((sp) => sp.length ? sp.map(([s, e]) => fmt(s) + "–" + fmt(e)).join(", ") : "gesloten");
    const out = [];
    for (let i = 0; i < 7;) {
      let j = i;
      while (j + 1 < 7 && txt[j + 1] === txt[i]) j++;
      out.push((i === j ? NL[i] : NL[i] + "–" + NL[j]) + " " + txt[i]);
      i = j + 1;
    }
    return out.join(" · ");
  }

  return { parse, status, describe };
})();
