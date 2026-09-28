# Brief：tally —— 记账 CSV 汇总小工具

做一个命令行小工具 `tally`：读一份记账 CSV，按类别汇总金额。用 Bun 写（TypeScript），不依赖任何第三方包。

## 输入

CSV，第一行是表头 `date,category,amount`。`date` 是 `YYYY-MM-DD`，`amount` 是可以带小数的数字，可能为负（表示退款）。样例在 `samples/expenses.csv`。

## 用法

    bun tool/tally.ts <csv 文件> [--month YYYY-MM]

## 输出

每个类别一行：`<类别>` + 一个制表符 + `<合计>`，合计保留两位小数；按合计从大到小排序，合计相同的按类别名的字符编码升序。最后一行是 `TOTAL` + 一个制表符 + `<总计>`。给了 `--month` 就只统计那个月的行。

## 出错

文件不存在、表头不对、某一行金额不是数字时，往标准错误输出一句说明，以退出码 1 结束，不输出汇总。

## 交付（都放在 `tool/` 下）

- `tool/tally.ts`：入口。
- `tool/tally.test.ts`：测试，用 `bun test`，至少覆盖排序、`--month` 过滤、负数金额、表头错误四种情况。在 `tool/` 目录里运行 `bun test` 要全部通过。
- `tool/README.md`：写明怎么运行（上面那条命令）、怎么跑测试、输出格式。

## 对照

在工作区根目录运行 `bun tool/tally.ts samples/expenses.csv`，输出应当正好是（字段之间是一个制表符）：

    software	198.00
    books	110.80
    food	106.00
    transport	35.50
    TOTAL	450.30

运行 `bun tool/tally.ts samples/expenses.csv --month 2026-08`，输出应当正好是：

    software	99.00
    food	80.70
    books	68.00
    transport	0.00
    TOTAL	247.70

交付前要亲自跑过测试和上面两条命令。不要指定谁做哪一步。
