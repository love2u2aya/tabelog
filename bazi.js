/*!
 * bazi.js — 四柱推命（三柱／四柱）エンジン  ※依存ライブラリなし
 * --------------------------------------------------------------------------
 * 「考え方」を他プロジェクトに移植するための単一ファイル・モジュール。
 * Node (require) / ブラウザ (<script> → window.Bazi) / bundler(import) で動作。
 *
 * ■ 設計の要点（この順で命式を組み立てる）
 *   1. 日柱：グレゴリオ暦→ユリウス通日(JDN)を求め、60日周期に落とす。
 *            dayIndex = (JDN + 49) mod 60  （0=甲子）。2000-01-01=戊午 で検証済み。
 *   2. 月柱：太陽の黄経(λ)を計算し、節気（立春=315°ほか30°刻み）で「月の地支」を決める。
 *            月の天干は年干からの「五虎遁」で決定。
 *   3. 年柱：立春を境に年が変わる（節分前は前年扱い）。λ<315°かつ1〜2月なら前年。
 *   4. 時柱：出生時刻があれば2時間刻みで地支、天干は日干からの「五鼠遁」。
 *   5. 付随情報：蔵干／十二運星／五行バランス（蔵干含む）／身強・身弱／空亡／大運。
 *
 * ■ 主API
 *   Bazi.chart({year, month, day, hour=null, gender='M'|'F'}) → 命式オブジェクト
 *   低レベル関数と定数も個別にエクスポート（toJDN, solarLongitude, tenGod ...）。
 *
 * ■ 注意
 *   - 太陽黄経は Meeus 簡易式（誤差~0.01°）。日付は現地正午(JST=UT+9)で評価している。
 *     別タイムゾーンで使う場合は toJD 内のオフセットを調整すること。
 *   - あくまでエンタメ用途を想定した実装。流派により異なる解釈がある。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bazi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ===== 基本定数 =====
  var STEMS = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];       // 天干
  var BRANCHES = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥']; // 地支
  var ELEMENTS = ['木','火','土','金','水'];
  // 地支の主たる五行（子..亥 → 0木/1火/2土/3金/4水）
  var BRANCH_ELEMENT = [4,2,0,0,2,1,1,2,3,3,2,4];
  // 蔵干（地支に隠れた天干のindex, 本気→中気→余気）
  var HIDDEN = [[9],[5,9,7],[0,2,4],[1],[4,1,9],[2,6,4],[3,5],[5,3,1],[6,8,4],[7],[4,7,3],[8,0]];
  // 十二運星
  var STAGES = ['長生','沐浴','冠帯','建禄','帝旺','衰','病','死','墓','絶','胎','養'];
  // 各天干の「長生」の地支index（甲..癸）
  var LONG_SHENG = [11,6,2,9,2,9,5,0,8,3];
  // 通変星（十神）
  var TEN_GODS = ['比肩','劫財','食神','傷官','偏財','正財','偏官','正官','偏印','印綬'];

  var stemElement = function (i) { return Math.floor(i / 2); };   // 0..4
  var stemIsYang  = function (i) { return i % 2 === 0; };

  // ===== 暦計算 =====
  // グレゴリオ暦→ユリウス通日(正午基準の整数)
  function toJDN(y, m, d) {
    var a = Math.floor((14 - m) / 12), y2 = y + 4800 - a, m2 = m + 12 * a - 3;
    return d + Math.floor((153 * m2 + 2) / 5) + 365 * y2
      + Math.floor(y2 / 4) - Math.floor(y2 / 100) + Math.floor(y2 / 400) - 32045;
  }
  // 太陽の見かけの黄経(度, 0..360)  Meeus 簡易式
  function solarLongitude(jd) {
    var T = (jd - 2451545) / 36525;
    var L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    var M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T, Mr = M * Math.PI / 180;
    var C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr)
          + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr)
          + 0.000289 * Math.sin(3 * Mr);
    var om = 125.04 - 1934.136 * T;
    var lam = L0 + C - 0.00569 - 0.00478 * Math.sin(om * Math.PI / 180);
    return ((lam % 360) + 360) % 360;
  }
  // 現地正午(JST=UT+9)のユリウス日。JDN(正午UT)から9時間手前 = -0.375日。
  function toJD_noonLocal(y, m, d) { return toJDN(y, m, d) - 0.375; }
  // 節気ベースの「月インデックス」 0=寅月(立春〜) … 11=丑月
  function solarMonthIndex(y, m, d) {
    var lam = solarLongitude(toJD_noonLocal(y, m, d));
    return Math.floor(((((lam - 315) % 360) + 360) % 360) / 30);
  }

  // ===== 通変星 =====
  // 日干(dayStemIdx)から見た他の天干(otherStemIdx)の十神
  function tenGod(dayStemIdx, otherStemIdx) {
    var De = stemElement(dayStemIdx), Dy = stemIsYang(dayStemIdx);
    var Oe = stemElement(otherStemIdx), Oy = stemIsYang(otherStemIdx);
    var same = (Dy === Oy);
    if (Oe === De) return same ? '比肩' : '劫財';
    if (Oe === (De + 1) % 5) return same ? '食神' : '傷官';
    if (Oe === (De + 2) % 5) return same ? '偏財' : '正財';
    if (Oe === (De + 3) % 5) return same ? '偏官' : '正官';
    return same ? '偏印' : '印綬';
  }
  // 十二運星（日干 × 地支）
  function twelveStage(dayStemIdx, branchIdx) {
    var ls = LONG_SHENG[dayStemIdx];
    var k = stemIsYang(dayStemIdx)
      ? ((branchIdx - ls) % 12 + 12) % 12
      : ((ls - branchIdx) % 12 + 12) % 12;
    return STAGES[k];
  }

  // ===== 各柱の算出 =====
  function yearPillar(y, m, d) {
    var lam = solarLongitude(toJD_noonLocal(y, m, d));
    var py = y;
    if (m <= 2 && lam < 315) py -= 1;            // 立春前は前年
    var s = ((py - 4) % 10 + 10) % 10, b = ((py - 4) % 12 + 12) % 12;
    return { stem: s, branch: b, forYear: py };
  }
  function monthPillar(y, m, d, yearStemIdx) {
    var mi = solarMonthIndex(y, m, d);           // 0=寅
    var order = mi + 1;                          // 寅=1
    var tiger = (2 + 2 * (yearStemIdx % 5)) % 10; // 五虎遁：寅月の天干
    var s = (tiger + (order - 1)) % 10;
    var b = (order + 1) % 12;                    // 子=0 index上で寅=2
    return { stem: s, branch: b };
  }
  function dayPillar(y, m, d) {
    var idx = (((toJDN(y, m, d) + 49) % 60) + 60) % 60; // 0=甲子
    return { stem: idx % 10, branch: idx % 12, sexagenary: idx };
  }
  function hourPillar(hour, dayStemIdx) {
    var b = Math.floor((hour + 1) / 2) % 12;      // 時支（子=23-1時）
    var zi = ((dayStemIdx % 5) * 2) % 10;         // 五鼠遁：子刻の天干
    var s = (zi + b) % 10;                         // 時干
    return { stem: s, branch: b };
  }

  // ===== 五行・身強身弱・空亡・大運 =====
  // 五行バランス（天干＋各地支の蔵干をすべて集計）→ [木,火,土,金,水]
  function fiveElementCount(stemIdxs, branchIdxs) {
    var c = [0,0,0,0,0];
    stemIdxs.forEach(function (s) { c[stemElement(s)]++; });
    branchIdxs.forEach(function (b) { HIDDEN[b].forEach(function (z) { c[stemElement(z)]++; }); });
    return c;
  }
  // 身強・身弱（簡易：日主と同五行＋日主を生む五行を味方として集計）
  function bodyStrength(dayStemIdx, counts) {
    var de = stemElement(dayStemIdx);
    var support = counts[de] + counts[(de + 4) % 5];
    var total = counts.reduce(function (a, b) { return a + b; }, 0);
    return { label: support * 2 >= total ? '身強' : '身弱', support: support, total: total };
  }
  // 空亡（天中殺）：日柱の60干支から
  function voidBranches(daySexagenary) {
    var j = Math.floor(daySexagenary / 10);
    var a = (j * 10 + 10) % 12, b = (j * 10 + 11) % 12;
    return [a, b];
  }
  // 大運（10年ごと）。年干の陰陽×性別で順逆、隣接する節までの日数÷3で起運年齢。
  function majorFortune(y, m, d, yearStemIdx, monthStemIdx, monthBranchIdx, isMale) {
    var forward = (stemIsYang(yearStemIdx) === isMale);
    var baseMonth = solarMonthIndex(y, m, d), step = forward ? 1 : -1;
    var days = 0, cy = y, cm = m, cd = d;
    for (var k = 0; k < 40; k++) {
      var dt = new Date(Date.UTC(cy, cm - 1, cd));
      dt.setUTCDate(dt.getUTCDate() + step);
      cy = dt.getUTCFullYear(); cm = dt.getUTCMonth() + 1; cd = dt.getUTCDate();
      days++;
      if (solarMonthIndex(cy, cm, cd) !== baseMonth) break;
    }
    var startAge = Math.max(1, Math.round((forward ? days : days - 1) / 3));
    var mIdx = -1;
    for (var i = 0; i < 60; i++) if (i % 10 === monthStemIdx && i % 12 === monthBranchIdx) { mIdx = i; break; }
    var list = [];
    for (var n = 0; n < 8; n++) {
      var idx = ((mIdx + (forward ? (n + 1) : -(n + 1))) % 60 + 60) % 60;
      list.push({ age: startAge + n * 10, stem: idx % 10, branch: idx % 12,
        name: STEMS[idx % 10] + BRANCHES[idx % 12] });
    }
    return { forward: forward, startAge: startAge, list: list };
  }

  // ===== 高レベルAPI =====
  function decoratePillar(label, stemIdx, branchIdx, dayStemIdx, isDay) {
    return {
      label: label,
      stem: STEMS[stemIdx], branch: BRANCHES[branchIdx],
      stemIndex: stemIdx, branchIndex: branchIdx,
      element: ELEMENTS[stemElement(stemIdx)],
      yinYang: stemIsYang(stemIdx) ? '陽' : '陰',
      hiddenStems: HIDDEN[branchIdx].map(function (z) { return STEMS[z]; }),
      twelveStage: twelveStage(dayStemIdx, branchIdx),
      tenGod: isDay ? '日主' : tenGod(dayStemIdx, stemIdx)
    };
  }

  /**
   * 命式を計算して返す。
   * @param {Object} o
   * @param {number} o.year  西暦
   * @param {number} o.month 1-12
   * @param {number} o.day   1-31
   * @param {number|null} [o.hour] 0-23（未指定なら三柱）
   * @param {'M'|'F'} [o.gender] 大運の順逆に使用（既定 'M'）
   */
  function chart(o) {
    var y = o.year, m = o.month, d = o.day;
    var hour = (o.hour === 0 || o.hour) ? o.hour : null;
    var isMale = (o.gender || 'M') === 'M';

    var yp = yearPillar(y, m, d);
    var mp = monthPillar(y, m, d, yp.stem);
    var dp = dayPillar(y, m, d);
    var dayStemIdx = dp.stem;

    var stemIdxs = [yp.stem, mp.stem, dp.stem];
    var branchIdxs = [yp.branch, mp.branch, dp.branch];

    var pillars = {
      year:  decoratePillar('年柱', yp.stem, yp.branch, dayStemIdx, false),
      month: decoratePillar('月柱', mp.stem, mp.branch, dayStemIdx, false),
      day:   decoratePillar('日柱', dp.stem, dp.branch, dayStemIdx, true)
    };
    if (hour !== null) {
      var hp = hourPillar(hour, dayStemIdx);
      stemIdxs.push(hp.stem); branchIdxs.push(hp.branch);
      pillars.hour = decoratePillar('時柱', hp.stem, hp.branch, dayStemIdx, false);
    }

    var counts = fiveElementCount(stemIdxs, branchIdxs);
    var dominant = counts.indexOf(Math.max.apply(null, counts));
    var vb = voidBranches(dp.sexagenary);
    var du = majorFortune(y, m, d, yp.stem, mp.stem, mp.branch, isMale);
    du.list.forEach(function (x) { x.tenGod = tenGod(dayStemIdx, x.stem); });

    return {
      input: { year: y, month: m, day: d, hour: hour, gender: isMale ? 'M' : 'F' },
      threePillarOnly: hour === null,
      solarYearForYearPillar: yp.forYear,   // 立春前なら前年
      dayMaster: { stem: STEMS[dayStemIdx], element: ELEMENTS[stemElement(dayStemIdx)],
                   yinYang: stemIsYang(dayStemIdx) ? '陽' : '陰' },
      pillars: pillars,
      fiveElements: {
        counts: counts,                     // [木,火,土,金,水]
        byName: ELEMENTS.reduce(function (o2, name, i) { o2[name] = counts[i]; return o2; }, {}),
        dominant: ELEMENTS[dominant]
      },
      bodyStrength: bodyStrength(dayStemIdx, counts),
      voidBranches: [BRANCHES[vb[0]], BRANCHES[vb[1]]],
      majorFortune: du
    };
  }

  return {
    // 高レベル
    chart: chart,
    // 個別柱
    yearPillar: yearPillar, monthPillar: monthPillar, dayPillar: dayPillar, hourPillar: hourPillar,
    // 派生情報
    fiveElementCount: fiveElementCount, bodyStrength: bodyStrength,
    voidBranches: voidBranches, majorFortune: majorFortune,
    tenGod: tenGod, twelveStage: twelveStage,
    // 暦
    toJDN: toJDN, solarLongitude: solarLongitude, solarMonthIndex: solarMonthIndex,
    // 定数
    STEMS: STEMS, BRANCHES: BRANCHES, ELEMENTS: ELEMENTS,
    BRANCH_ELEMENT: BRANCH_ELEMENT, HIDDEN: HIDDEN, STAGES: STAGES, TEN_GODS: TEN_GODS,
    stemElement: stemElement, stemIsYang: stemIsYang
  };
});
