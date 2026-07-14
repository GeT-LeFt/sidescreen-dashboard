/*!
 * lunar.js - 零依赖农历(阴历)转换库
 * 浏览器 + Node 双用
 *
 * 算法: 经典 1900-2100 年"农历信息压缩表"(lunarInfo)实现
 * (这是被广泛使用的中国农历算法: 每年用一个 20 bit 整数编码该年
 *  12 个月的大小月分布 + 闰月月份 + 闰月大小)
 *
 * 用法:
 *   Lunar.date(new Date())   -> { monthCn: "五月", dayCn: "廿九", isLeap: false, ... }
 *   Lunar.weekCn(new Date()) -> "星期一"
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // 1900-2100 年农历信息表, 共 201 项
  // 每项是一个 20 bit 整数:
  //   bit19-bit16 : 闰月月份 (0 表示该年没有闰月)
  //   bit15-bit4  : 12 个月份的大小月 (1=30天大月, 0=29天小月), 从正月到腊月, 由高位到低位
  //   bit3-bit0   : (与 bit19-16 相同的闰月月份, 部分实现只用低4位存闰月月份,
  //                  这里采用经典实现: 低4位存闰月月份, 高16位第0bit(0x10000)存闰月是否大月)
  // 具体见下方 leapMonth / leapDays / monthDays 的位运算
  // ------------------------------------------------------------------
  var lunarInfo = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5d0, 0x14573, 0x052d0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b5a0, 0x195a6, // 1970-1979
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
    0x05aa0, 0x076a3, 0x096d0, 0x04bd7, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
    0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
    0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
    0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
    0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
    0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
    0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
    0x0d520                                                                                    // 2100
  ];

  var Gan = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  var Zhi = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  var Animals = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

  var nStr1 = ['日', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  var nStr2 = ['初', '十', '廿', '卅'];
  var monthCnNames = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];

  var weekCnNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  // 返回农历 y 年闰月是哪个月, 0 为没有闰月
  function leapMonth(y) {
    return lunarInfo[y - 1900] & 0xf;
  }

  // 返回农历 y 年闰月的天数, 若该年没有闰月则返回 0
  function leapDays(y) {
    if (leapMonth(y)) {
      return (lunarInfo[y - 1900] & 0x10000) ? 30 : 29;
    }
    return 0;
  }

  // 返回农历 y 年 m 月(普通月, 1-12)的天数
  function monthDays(y, m) {
    if (m > 12 || m < 1) return -1;
    return (lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29;
  }

  // 返回农历 y 年的总天数
  function lYearDays(y) {
    var i, sum = 348; // 12 个月 * 29 天基数
    for (i = 0x8000; i > 0x8; i >>= 1) {
      sum += (lunarInfo[y - 1900] & i) ? 1 : 0;
    }
    return sum + leapDays(y);
  }

  // 传入公历(阳历) y,m,d 返回 Date 对应的儒略日整数偏移(用于日期算术),
  // 这里直接使用 Date.UTC 做天数差, 避免时区/夏令时问题, 以本地时区的年月日为准
  function toLocalDayCount(y, m, d) {
    // 使用 Date.UTC 仅作为线性递增的"天数"载体, 不代表真实 UTC 时刻
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }

  // 农历基准日: 1900年正月初一, 对应公历 1900-01-31
  var BASE_YEAR = 1900;
  var BASE_MONTH = 1;
  var BASE_DAY = 31;

  // 计算公历日期与 1900-01-31 之间相差的天数
  function daysBetween(y, m, d) {
    return toLocalDayCount(y, m, d) - toLocalDayCount(BASE_YEAR, BASE_MONTH, BASE_DAY);
  }

  // 核心: 将公历(本地时区) y,m,d 转换为农历信息
  function solar2lunar(y, m, d) {
    if (y < 1900 || y > 2100) {
      throw new Error('lunar.js: 年份超出支持范围 (1900-2100): ' + y);
    }

    var offset = daysBetween(y, m, d);

    var lYear = 1900;
    var temp = 0;
    var i;
    for (i = 1900; i <= 2100; i++) {
      temp = lYearDays(i);
      if (offset < temp) {
        lYear = i;
        break;
      }
      offset -= temp;
    }

    var leap = leapMonth(lYear);
    var isLeap = false;
    var lMonth = 1;

    for (i = 1; i <= 13; i++) {
      if (leap > 0 && i === leap + 1 && !isLeap) {
        i--;
        isLeap = true;
        temp = leapDays(lYear);
      } else {
        temp = monthDays(lYear, i);
      }

      if (isLeap && i === leap + 1) {
        isLeap = false;
      }

      if (offset < temp) {
        lMonth = i;
        break;
      }
      offset -= temp;
    }

    var lDay = offset + 1;

    return {
      lYear: lYear,
      lMonth: lMonth,
      lDay: lDay,
      isLeap: isLeap
    };
  }

  function dayCn(day) {
    var s;
    switch (day) {
      case 10:
        s = '初十';
        break;
      case 20:
        s = '二十';
        break;
      case 30:
        s = '三十';
        break;
      default:
        s = nStr2[Math.floor(day / 10)] + nStr1[day % 10];
    }
    return s;
  }

  function monthCn(month, isLeap) {
    var s = monthCnNames[month - 1] + '月';
    return isLeap ? '闰' + s : s;
  }

  function ganZhiYear(lunarYear) {
    var ganKey = (lunarYear - 4) % 10;
    var zhiKey = (lunarYear - 4) % 12;
    if (ganKey < 0) ganKey += 10;
    if (zhiKey < 0) zhiKey += 12;
    return Gan[ganKey] + Zhi[zhiKey];
  }

  function animalYear(lunarYear) {
    var key = (lunarYear - 4) % 12;
    if (key < 0) key += 12;
    return Animals[key];
  }

  var Lunar = {};

  /**
   * 将公历 Date(本地时区) 转换为农历信息
   * @param {Date} d
   * @returns {{monthCn: string, dayCn: string, isLeap: boolean, lYear: number, lMonth: number, lDay: number, ganZhi: string, animal: string}}
   */
  Lunar.date = function (d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) {
      throw new Error('lunar.js: Lunar.date(d) 需要传入合法的 Date 对象');
    }
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();

    var r = solar2lunar(y, m, day);

    return {
      monthCn: monthCn(r.lMonth, r.isLeap),
      dayCn: dayCn(r.lDay),
      isLeap: r.isLeap,
      lYear: r.lYear,
      lMonth: r.lMonth,
      lDay: r.lDay,
      ganZhi: ganZhiYear(r.lYear),
      animal: animalYear(r.lYear)
    };
  };

  /**
   * 返回中文星期, 如 "星期一"
   * @param {Date} d
   * @returns {string}
   */
  Lunar.weekCn = function (d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) {
      throw new Error('lunar.js: Lunar.weekCn(d) 需要传入合法的 Date 对象');
    }
    return weekCnNames[d.getDay()];
  };

  // 暴露内部函数供自测使用(非公开 API, 但不影响正常使用)
  Lunar._internal = {
    lunarInfo: lunarInfo,
    leapMonth: leapMonth,
    leapDays: leapDays,
    monthDays: monthDays,
    lYearDays: lYearDays
  };

  if (typeof module !== 'undefined') module.exports = Lunar; else window.Lunar = Lunar;
})();
