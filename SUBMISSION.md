# 投稿到插件市场 · 操作指南

`dsh-reply-timer` 已经满足精选列表的全部硬性门槛，只差把它推到你的公开仓库并提一个 PR。
下面按「一次性准备 → 建仓库 → 提 PR → 上架后」四段走。

> **GitHub owner 已填好**：`henry1996-yl`（`package.json` 的 repository/bugs/homepage、
> 投稿 YAML 的 url/name、下方命令均已替换）。如果换了账号，全局搜 `henry1996-yl` 替换即可。

> 市场列表来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
> **不是** `dshmarket` 应用仓库本身。往 `dshmarket` 提条目会被拒；往 awesome 列表的
> `data/plugins/` 加一个 YAML 才是正确入口。站点与 `dsh` 的「插件」页签会在合并后自动收录（通常 1 天内）。

---

## 0. 已替你准备好的东西（本目录）

| 文件 | 作用 | 状态 |
| --- | --- | --- |
| `package.json` | 已含 `dsh.bundle.patch`（CI 第一道校验要的）、`dsh.client`、`repository`/`bugs`/`homepage`、MIT、keywords | ✅ 已填 `henry1996-yl` |
| `cordis.patch.yml` | loader 插入记录，注释已与 v2 双半场架构对齐 | ✅ |
| `LICENSE` | MIT | ✅ |
| `.gitignore` | 排除 `samples.json`（含本机会话数据）、`*.tgz` 等运行时产物 | ✅ |
| `docs/DETAIL.md` + `docs/preview.svg` | 插件详情页的特性图（由 `locale/*.json` 的 `meta.detail` 指向，只放一张图） | ✅ |
| `submission/henry1996-yl__dsh-reply-timer.yml` | 投稿 YAML（**这个文件不要放进插件根目录发布**，见步骤 2） | ✅ 已填好，可直接复制 |
| `README.md` / `locale/{zh,en}.json` | 描述与真实功能一致（可人工评审核对） | ✅ |
| `dsh-reply-timer-2.4.0.tgz` | 预构建的 Release 资产（见步骤 1 的可选项） | 与本包同级目录生成 |

**投稿 YAML 文件名规则**：`data/plugins/<owner>__<repo>.yml` → `henry1996-yl__dsh-reply-timer.yml`，
已按此命名。

---

## 1. 建公开仓库并打 topic（今天做）

```bash
cd dsh-reply-timer
git init
git add .
git commit -m "dsh-reply-timer v2.4.0: honest reply timer with stall detection and ledger"
# 用 gh（需已登录）或到 GitHub 网页新建公开仓库，然后：
gh repo create dsh-reply-timer --public --source=. --remote=origin --push
gh repo edit henry1996-yl/dsh-reply-timer --add-topic dsh-plugin   # CI/人工评审的硬性要求
```

没有 `gh` 就到网页新建空仓库 `https://github.com/henry1996-yl/dsh-reply-timer`，再
`git remote add origin <url> && git push -u origin main`，并在仓库页右侧
**About → Topics** 加 `dsh-plugin`。

> ⚠️ **仓库必须存在满 1 天**才能过 CI 的年龄检查（无提交数门槛）。今天建好，明天再提 PR。

**（可选）用 tgz 做预构建安装**：把 `dsh-reply-timer-2.4.0.tgz` 作为资产传到你仓库的 GitHub Release。
在投稿 YAML 里加一行（资产名**不要带版本号**，`latest/download/` 以后会失效）：

```yaml
tarball: https://github.com/henry1996-yl/dsh-reply-timer/releases/download/v2.4.0/dsh-reply-timer.tgz
```

发不发 npm、用不用 tarball 都不影响收录；源码安装是默认路径。

---

## 2. 提 PR（明天，仓库满 1 天后）

```bash
# fork awesome-dsh-plugin 后克隆你的 fork
git clone https://github.com/henry1996-yl/awesome-dsh-plugin
cd awesome-dsh-plugin
# 用本包 submission/ 里已填好的 YAML（文件名已正确）
cp /path/to/dsh-reply-timer/submission/henry1996-yl__dsh-reply-timer.yml \
   data/plugins/henry1996-yl__dsh-reply-timer.yml
git checkout -b add-dsh-reply-timer
git add data/plugins/henry1996-yl__dsh-reply-timer.yml
git commit -m "Add dsh-reply-timer"
git push -u origin add-dsh-reply-timer
gh pr create --fill
```

一个 PR 最多加 3 条；只改你自己的这一个 YAML，**不要手改 README / 官网**（它们是自动生成的）。

---

## 3. CI 会依次检查 4 道（了解即可）

1. 条目数 ≤ 3；
2. 从你仓库 `package.json` 拉取并验证 `dsh.bundle`（我们已声明，✅）；
3. 仓库年龄 ≥ 1 天（所以要等明天）；
4. `awesome-lint` 校验双语一致性、日期、截图等。

CI 红了就在**同一分支**推修复，不用重开 PR。之后维护者会读源码，核对描述属实、非空壳、
无凭据外传、PR 只改自己条目——我们这几项都满足。合并后什么都不用做，站点自动重构。

---

## 4. 上架之后

- 改插件信息/截图：推你自己的仓库即可（截图下次构建自动生效），或只改 `data/plugins/` 里你那条 YAML。
- 停更/归档/删仓库会被定期扫描移除，记得保持维护。
- 市场里的「收录 ≠ 背书」，用户仍需自行判断是否信任第三方代码。

---

### 外部依据

- [awesome-dsh-plugin 投稿全流程（中文，CSDN）](https://blog.csdn.net/gitblog_00021/article/details/167389746)
- [dshmarket 应用仓库说明：列表来自 awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
- [dsh.so format 1 索引规范](https://www.dsh.so/data/market-index/)（严格通道，与本次 PR 流程相互独立）
