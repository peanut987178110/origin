/* =========================================================================
   market_data.js · "关于潮汐"页里的行业数据（v5.1）
   -------------------------------------------------------------------------
   唯一数据源：本文件与 docs/29_市场数据手册.md 必须一致（tools/verify_app.js 会检查每条 id 都出现在 docs/29）。
   规则：
     · 每条必须有来源（source）、链接（url）、发布日期（date）、可信度等级（level）
     · App 里只展示 A（一手来源）和 B（可靠媒体转述且注明原始来源）级
     · 只放第三方公开数据。潮汐自己没有用户，不放任何"我们的用户数"
     · 数字会过期：checked 是最后一次人工核对的日期，每季度复核一次
   选哪些放进 App：只放能解释"潮汐为什么这样设计"的数据（为什么只面向成年人、为什么提醒 AI 身份、
   为什么北极星看夜数不看时长），竞品经营数据只留在 docs/29。
   构建时由 tools/build_app.js 内联进 App（window.TideMarket）；Node 里可直接 require。
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrbitMarket = root.TideMarket = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    checked: '2026-11-10',
    facts: [
      {
        id: 'appfigures_apps_2025', level: 'B', date: '2025-08-12',
        source: 'Appfigures, reported by TechCrunch',
        url: 'https://techcrunch.com/2025/08/12/ai-companion-apps-on-track-to-pull-in-120m-in-2025/',
        en: 'There were 337 active, revenue-generating AI companion apps worldwide as of mid-2025.',
        zh: '截至 2025 年年中，全球有 337 款在营且有收入的 AI 陪伴应用。'
      },
      {
        id: 'appfigures_spend_h1_2025', level: 'B', date: '2025-08-12',
        source: 'Appfigures, reported by TechCrunch',
        url: 'https://techcrunch.com/2025/08/12/ai-companion-apps-on-track-to-pull-in-120m-in-2025/',
        en: 'AI companion apps earned $82M in consumer spending in H1 2025, on track for over $120M for the year.',
        zh: '2025 年上半年 AI 陪伴应用的用户付费为 8,200 万美元，全年预计超过 1.2 亿美元（应用商店口径）。'
      },
      {
        id: 'appfigures_downloads_h1_2025', level: 'B', date: '2025-08-12',
        source: 'Appfigures, reported by TechCrunch',
        url: 'https://techcrunch.com/2025/08/12/ai-companion-apps-on-track-to-pull-in-120m-in-2025/',
        en: 'Downloads reached 60M in H1 2025, up 88% year over year.',
        zh: '2025 年上半年下载量 6,000 万次，同比增长 88%。'
      },
      {
        id: 'appfigures_top10_share', level: 'B', date: '2025-08-12',
        source: 'Appfigures, reported by TechCrunch',
        url: 'https://techcrunch.com/2025/08/12/ai-companion-apps-on-track-to-pull-in-120m-in-2025/',
        en: 'The top 10% of AI companion apps earn 89% of the category revenue.',
        zh: '收入最高的 10% 的 AI 陪伴应用拿走了这个品类 89% 的收入。'
      },
      {
        id: 'hbr_2025_top_use', level: 'A', date: '2025-04-09',
        source: 'Harvard Business Review',
        url: 'https://hbr.org/2025/04/how-people-are-really-using-gen-ai-in-2025',
        en: '"Therapy/companionship" ranked as the #1 way people used generative AI in 2025 (based on public forum posts, not a survey).',
        zh: '2025 年"倾诉/陪伴"成为人们使用生成式 AI 的第一大用途（基于公开论坛帖子统计，不是抽样调查）。'
      },
      {
        id: 'csm_teens_2025', level: 'A', date: '2025-07-16',
        source: 'Common Sense Media / NORC (n=1,060)',
        url: 'https://www.commonsensemedia.org/research/talk-trust-and-trade-offs-how-and-why-teens-use-ai-companions',
        en: '72% of US teens aged 13–17 have used an AI companion; the researchers recommend no one under 18 use them. Tide is adults-only.',
        zh: '72% 的美国 13–17 岁青少年用过 AI 陪伴，研究方建议 18 岁以下不要使用。潮汐只面向成年人。'
      },
      {
        id: 'openai_mit_2025', level: 'A', date: '2025-04-04',
        source: 'OpenAI & MIT Media Lab (arXiv 2504.03888)',
        url: 'https://arxiv.org/abs/2504.03888',
        en: 'In a 4-week study of 981 people, heavier daily chatbot use was associated with more loneliness. That is why Tide measures nights visited, not minutes.',
        zh: '一项 981 人、为期 4 周的研究发现：每天和聊天机器人聊得越久，孤独感越高。所以潮汐看"来了几个晚上"，不看"聊了多久"。'
      },
      {
        id: 'ftc_6b_2025', level: 'A', date: '2025-09-11',
        source: 'US Federal Trade Commission',
        url: 'https://www.ftc.gov/news-events/news/press-releases/2025/09/ftc-launches-inquiry-ai-chatbots-acting-companions',
        en: 'The FTC opened an inquiry into 7 companies whose AI chatbots act as companions, focusing on effects on children and teens.',
        zh: '美国联邦贸易委员会对 7 家提供"陪伴型"聊天机器人的公司启动调查，重点关注对儿童和青少年的影响。'
      },
      {
        id: 'ny_gbl_47', level: 'A', date: '2025-11-05',
        source: 'New York General Business Law §1700–1704',
        url: 'https://www.nysenate.gov/legislation/laws/GBS/1702',
        en: 'New York requires AI companions to say they are not human at the start of a chat and at least every 3 hours. Tide does both.',
        zh: '纽约州要求 AI 陪伴在对话开始时、以及连续使用每 3 小时告知用户"你不是在和真人交流"。潮汐两条都做了。'
      },
      {
        id: 'ca_sb243', level: 'A', date: '2025-10-13',
        source: 'California SB 243 (Bus. & Prof. Code §22601–22606)',
        url: 'https://sd18.senate.ca.gov/news/first-nation-ai-chatbot-safeguards-signed-law',
        en: 'California requires companion chatbots to have a self-harm protocol that refers users to crisis services (in force since Jan 1, 2026).',
        zh: '加州 SB 243 要求陪伴型聊天机器人具备防自伤协议，并向用户转介危机服务（2026 年 1 月 1 日起施行）。'
      }
    ]
  };
});
