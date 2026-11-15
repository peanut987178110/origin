-- =========================================================================
-- queries.sql · 潮汐 v5 核心指标（SQLite 方言，直接跑在 server/tide.db 上）
-- -------------------------------------------------------------------------
-- 每段以 "-- name: xxx" 开头，report.js 按名字执行。
-- 口径对齐 docs/13_数据埋点与指标字典.md。
--
-- 关键口径（面试会被追问，先写死）：
--   · 激活    = 注册后 24 小时内在同一会话发出 ≥3 条消息
--   · Dn 留存 = 注册日之后第 n 个自然日（UTC）有 message_sent
--               分母只算"注册已满 n 天"的设备，否则新用户会把留存拉低
--   · 自然日用 UTC，因为服务端按 UTC 计额度；做区域分析时再换本地时区
-- =========================================================================

-- name: funnel
-- 新手漏斗：注册 → 确认 18+ → 选角色 → 发第 1 条 → 发满 3 条（激活）→ 看到付费墙 → 订阅
WITH s AS (SELECT device_id, MIN(ts) AS t0 FROM events WHERE name = 'signup' GROUP BY device_id),
     msg AS (SELECT e.device_id, COUNT(*) AS n
               FROM events e JOIN s ON s.device_id = e.device_id
              WHERE e.name = 'message_sent' AND e.ts <= datetime(s.t0, '+1 day')
              GROUP BY e.device_id)
SELECT 'signup'           AS step, 1 AS ord, COUNT(*) AS devices FROM s
UNION ALL SELECT 'age_confirmed',   2, COUNT(DISTINCT device_id) FROM events WHERE name = 'age_confirmed'
UNION ALL SELECT 'persona_selected',3, COUNT(DISTINCT device_id) FROM events WHERE name = 'persona_selected'
UNION ALL SELECT 'first_message',   4, COUNT(*) FROM msg WHERE n >= 1
UNION ALL SELECT 'activated_3msg',  5, COUNT(*) FROM msg WHERE n >= 3
UNION ALL SELECT 'paywall_view',    6, COUNT(DISTINCT device_id) FROM events WHERE name = 'paywall_view'
UNION ALL SELECT 'subscribe',       7, COUNT(DISTINCT device_id) FROM events WHERE name = 'subscribe'
ORDER BY ord;

-- name: retention
-- D1 / D3 / D7 留存（按注册日分组的 cohort）
WITH s AS (SELECT device_id, date(MIN(ts)) AS d0 FROM events WHERE name = 'signup' GROUP BY device_id),
     act AS (SELECT DISTINCT device_id, date(ts) AS d FROM events WHERE name = 'message_sent'),
     asof AS (SELECT date(MAX(ts)) AS today FROM events)
SELECT
  n AS day_n,
  SUM(CASE WHEN julianday((SELECT today FROM asof)) - julianday(s.d0) >= n THEN 1 ELSE 0 END) AS eligible,
  SUM(CASE WHEN EXISTS (SELECT 1 FROM act WHERE act.device_id = s.device_id
                         AND julianday(act.d) - julianday(s.d0) = n) THEN 1 ELSE 0 END) AS retained
FROM s, (SELECT 1 AS n UNION ALL SELECT 3 UNION ALL SELECT 7)
GROUP BY n ORDER BY n;

-- name: ab_nudge
-- A/B：nudge_v1（晚间主动关怀）对照 control。
-- 两个指标一起看：D7 留存（想要它涨）和"关闭通知/删号"率（不想要它涨）。
-- Finch 的教训：推送能拉回一部分人，也能赶走一部分人。
WITH s AS (SELECT device_id, date(MIN(ts)) AS d0 FROM events WHERE name = 'signup' GROUP BY device_id),
     asof AS (SELECT date(MAX(ts)) AS today FROM events),
     g AS (SELECT x.device_id, x.variant, s.d0 FROM experiments x JOIN s ON s.device_id = x.device_id WHERE x.exp = 'nudge_v1'),
     elig AS (SELECT * FROM g WHERE julianday((SELECT today FROM asof)) - julianday(d0) >= 7)
SELECT
  variant,
  COUNT(*) AS eligible_d7,
  SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.device_id = elig.device_id AND e.name = 'message_sent'
                         AND julianday(date(e.ts)) - julianday(elig.d0) = 7) THEN 1 ELSE 0 END) AS retained_d7,
  SUM(CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.device_id = elig.device_id AND e.name = 'nudge_dismissed'
                         AND json_extract(e.props, '$.action') = 'disable') THEN 1 ELSE 0 END) AS disabled_notifications
FROM elig GROUP BY variant ORDER BY variant;

-- name: onboarding_choice
-- 新手引导：每个"今晚是个什么样的晚上"选项 → 选了多少人 → 其中多少人激活
WITH s AS (SELECT device_id, MIN(ts) AS t0 FROM events WHERE name = 'signup' GROUP BY device_id),
     pick AS (SELECT device_id, json_extract(props, '$.choice') AS choice
                FROM events WHERE name = 'onboarding_step' AND json_extract(props, '$.step') = 'choice'),
     msg AS (SELECT e.device_id, COUNT(*) AS n FROM events e JOIN s ON s.device_id = e.device_id
              WHERE e.name = 'message_sent' AND e.ts <= datetime(s.t0, '+1 day') GROUP BY e.device_id)
SELECT pick.choice, COUNT(*) AS picked,
       SUM(CASE WHEN COALESCE(msg.n, 0) >= 3 THEN 1 ELSE 0 END) AS activated
FROM pick LEFT JOIN msg ON msg.device_id = pick.device_id
GROUP BY pick.choice ORDER BY picked DESC;

-- name: safety
-- 安全：危机路由次数（加州 SB 243 从 2027-07 起要求年报"转介次数"）
SELECT json_extract(props, '$.layer') AS layer, COUNT(*) AS crisis_referrals
FROM events WHERE name = 'crisis_routed' GROUP BY layer;

-- name: cost
-- 成本：每日 token 与按单价估算的花费（单价写在 report.js 里，和 docs/07 一致）
SELECT date(ts) AS day, COUNT(*) AS turns,
       SUM(COALESCE(json_extract(props, '$.tin'), 0))  AS tokens_in,
       SUM(COALESCE(json_extract(props, '$.tout'), 0)) AS tokens_out,
       ROUND(AVG(COALESCE(json_extract(props, '$.ms'), 0))) AS avg_ms
FROM events WHERE name = 'message_sent' GROUP BY day ORDER BY day;

-- name: segments
-- 分群：按"用户首次选择的角色"切分，看每个人群的激活与 D1。
-- 为什么按角色分：角色选择 ≈ 用户自报的"今晚是什么事"，是本产品最便宜也最有信息量的分群维度。
-- 面试追问"你会怎么分群"：先用产品里天然存在的自报维度（角色/引导选项/语言/地区），
-- 再用行为维度（下面的 usage_tier），最后才考虑模型打标签。
WITH s AS (SELECT device_id, MIN(ts) AS t0, date(MIN(ts)) AS d0 FROM events WHERE name = 'signup' GROUP BY device_id),
     first_persona AS (SELECT device_id, json_extract(props, '$.persona') AS persona, MIN(ts) AS t
                         FROM events WHERE name = 'persona_selected' GROUP BY device_id),
     msg AS (SELECT e.device_id, COUNT(*) AS n FROM events e JOIN s ON s.device_id = e.device_id
              WHERE e.name = 'message_sent' AND e.ts <= datetime(s.t0, '+1 day') GROUP BY e.device_id),
     d1 AS (SELECT DISTINCT e.device_id FROM events e JOIN s ON s.device_id = e.device_id
             WHERE e.name = 'message_sent' AND julianday(date(e.ts)) - julianday(s.d0) = 1),
     asof AS (SELECT date(MAX(ts)) AS today FROM events)
SELECT COALESCE(fp.persona, '(none)') AS persona,
       COUNT(*) AS devices,
       SUM(CASE WHEN COALESCE(msg.n, 0) >= 3 THEN 1 ELSE 0 END) AS activated,
       SUM(CASE WHEN julianday((SELECT today FROM asof)) - julianday(s.d0) >= 1 THEN 1 ELSE 0 END) AS d1_eligible,
       SUM(CASE WHEN d1.device_id IS NOT NULL THEN 1 ELSE 0 END) AS d1_retained
FROM s LEFT JOIN first_persona fp ON fp.device_id = s.device_id
       LEFT JOIN msg ON msg.device_id = s.device_id
       LEFT JOIN d1 ON d1.device_id = s.device_id
GROUP BY persona ORDER BY devices DESC;

-- name: usage_tier
-- 行为分群：按"近 7 天有对话的天数"把活跃用户分成 轻 / 中 / 重 三层。
-- 用"天数"而不是"消息数"：陪伴产品的价值是"每晚都来"，一天聊 100 条不比每天聊 5 条更健康。
-- 重度层（≥6 天）要单独盯：一是成本（见 docs/07 重度用户毛利），二是依赖风险（见 docs/12）。
WITH asof AS (SELECT date(MAX(ts)) AS today FROM events),
     days AS (SELECT device_id, COUNT(DISTINCT date(ts)) AS active_days, COUNT(*) AS turns
                FROM events
               WHERE name = 'message_sent'
                 AND julianday((SELECT today FROM asof)) - julianday(date(ts)) BETWEEN 0 AND 6
               GROUP BY device_id)
SELECT CASE WHEN active_days >= 6 THEN '3_heavy(6-7d)'
            WHEN active_days >= 3 THEN '2_medium(3-5d)'
            ELSE '1_light(1-2d)' END AS tier,
       COUNT(*) AS devices,
       SUM(turns) AS turns,
       ROUND(1.0 * SUM(turns) / COUNT(*), 1) AS turns_per_device
FROM days GROUP BY tier ORDER BY tier;

-- name: cohort_weekly
-- 周 cohort 留存矩阵：行 = 注册周，列 = 注册后第 0/1/2/3 周仍有对话的设备数。
-- 看法：横着看一行 = 这一批人怎么流失；竖着看一列 = 产品改动有没有让新一批人更好。
WITH s AS (SELECT device_id, date(MIN(ts)) AS d0 FROM events WHERE name = 'signup' GROUP BY device_id),
     act AS (SELECT DISTINCT e.device_id, CAST((julianday(date(e.ts)) - julianday(s.d0)) / 7 AS INTEGER) AS wk
               FROM events e JOIN s ON s.device_id = e.device_id WHERE e.name = 'message_sent')
SELECT strftime('%Y-W%W', s.d0) AS cohort,
       COUNT(DISTINCT s.device_id) AS size,
       COUNT(DISTINCT CASE WHEN act.wk = 0 THEN act.device_id END) AS w0,
       COUNT(DISTINCT CASE WHEN act.wk = 1 THEN act.device_id END) AS w1,
       COUNT(DISTINCT CASE WHEN act.wk = 2 THEN act.device_id END) AS w2,
       COUNT(DISTINCT CASE WHEN act.wk = 3 THEN act.device_id END) AS w3
FROM s LEFT JOIN act ON act.device_id = s.device_id
GROUP BY cohort ORDER BY cohort;

-- name: recall_loop
-- 召回链路：关怀提醒排了多少 → 被点开多少 → 隔天以上回来的回访有多少带着记忆被接住。
-- 三个数各自说明一件事：排程量 = 有多少人说过"有日期的具体事"；打开率 = 文案有没有用；
-- with_memory 占比 = 回来那一刻接不接得住。
SELECT
  (SELECT COUNT(*) FROM events WHERE name = 'nudge_scheduled') AS nudges_scheduled,
  (SELECT COUNT(*) FROM events WHERE name = 'nudge_opened')    AS nudges_opened,
  (SELECT COUNT(*) FROM events WHERE name = 'return_visit')    AS return_visits,
  (SELECT COUNT(*) FROM events WHERE name = 'return_visit' AND json_extract(props, '$.with_memory') = 1) AS return_with_memory;

-- name: reply_quality
-- 回复质量（机器可算的部分）：
--   retry_rate   = 首次回复太敷衍、触发重生成的比例 → 换模型 / 改提示词后第一个要看的数
--   recall_guard = 记忆陷阱硬规则拦截次数 → 涨了说明用户在测试"你记不记得我"，是记忆功能的需求信号
--   avg_ms       = 端到端耗时（含重生成）
SELECT COUNT(*) AS turns,
       SUM(CASE WHEN COALESCE(json_extract(props, '$.retries'), 0) > 0 THEN 1 ELSE 0 END) AS retried_turns,
       ROUND(100.0 * SUM(CASE WHEN COALESCE(json_extract(props, '$.retries'), 0) > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS retry_rate_pct,
       (SELECT COUNT(*) FROM events WHERE name = 'recall_miss') AS recall_guard,
       ROUND(AVG(COALESCE(json_extract(props, '$.ms'), 0))) AS avg_ms
FROM events WHERE name = 'message_sent';
