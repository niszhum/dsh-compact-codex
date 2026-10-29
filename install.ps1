#Requires -Version 5.1
<#
.SYNOPSIS
  一条命令安装 dsh-compact-codex。

.DESCRIPTION
  做五件事：获取仓库、建好运行时依赖的目录联接、生成 cordis.patch.yml、
  把本包挂进 dsh profile、跑 pnpm install。
  每一步都可逆：动过的文件先备份成 *.bak-compact-codex-<时间戳>。

.EXAMPLE
  # 在仓库根目录直接跑
  .\install.ps1

.EXAMPLE
  # 换 profile、指定 dsh 安装位置
  .\install.ps1 -Profile desktop -DshApp "D:\soft\dsh desk"

.EXAMPLE
  # 只看会改什么，不落盘
  .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
    # 本包所在目录。从别处调用时传路径。
    [string]$Repo = $PSScriptRoot,
    # dsh 的 home 目录，profile 放在它的 profiles\<name> 下。
    [string]$DshHome = $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.dsh' } else { Join-Path $HOME '.dsh' }),
    # profile 名。
    [string]$Profile = 'desktop',
    # dsh 的 resources\app\dsh 目录。留空则自动探测。
    [string]$DshApp,
    # 自动获取仓库时，落到这里。留空则为 $DshHome\plugins\dsh-compact-codex。
    [string]$InstallDir,
    # 自动获取所用的远程地址。
    [string]$RepoUrl = 'https://github.com/niszhum/dsh-compact-codex.git',
    # 跳过 pnpm install。
    [switch]$SkipPnpm,
    # 只打印将要执行的动作。
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}
function Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "    $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { throw $Message }

# 插件 import 的运行时包，必须能从本包的 node_modules 解析到。
$linkedPackages = @(
    'schemastery',
    'cordis',
    'dsh-compaction',
    'dsh-compaction-basic',
    'dsh-llm',
    'dsh-util-values',
    'dsh-session',
    'dsh-app-boot',
    'dsh-home-paths',
    'dsh-package-manifest',
    # sync-presets.mjs 要从它读官方 preset 声明。
    'dsh-web-app'
)

function Test-Repo([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return (Test-Path (Join-Path $Path 'lib\index.js')) -and (Test-Path (Join-Path $Path 'sync-presets.mjs'))
}

Step '检查环境'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { Fail '找不到 node。先装 Node.js（>= 22.5）。' }
Ok ("node：{0}" -f (node --version))

$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$profileFile = Join-Path $profileDir 'package.json'
if (-not (Test-Path $profileFile)) {
    Fail "找不到 profile：$profileFile
用 -Profile 指定 profile 名，或用 -DshHome 指定 dsh home。"
}
Ok "profile：$profileFile"

if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $DshHome 'plugins\dsh-compact-codex' }

# 管道执行（irm … | iex）时 $PSScriptRoot 为空，本地直跑时就是仓库根目录。
# 两种入口都先落到一处真实仓库上，后面几步才有东西可读。
Step '准备仓库'

if (-not (Test-Repo $Repo)) {
    if (-not [string]::IsNullOrWhiteSpace($Repo)) {
        Warn "指定的目录不像 dsh-compact-codex 的仓库：$Repo"
    }
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) {
        Fail "找不到 git，没法自动获取仓库。手动下载后重跑：`n.\install.ps1 -Repo <仓库路径>"
    }
    if (Test-Repo $InstallDir) {
        Ok "已有仓库：$InstallDir"
        if ($DryRun) {
            Warn '将执行：git pull --ff-only'
        } else {
            Push-Location $InstallDir
            try {
                git pull --ff-only
                if ($LASTEXITCODE -ne 0) { Warn '拉取失败，继续用本地已有的版本' }
            } finally { Pop-Location }
        }
    } elseif ($DryRun) {
        Warn ("将克隆：{0} -> {1}" -f $RepoUrl, $InstallDir)
        Write-Host ''
        Warn '试运行到此为止：后面几步要读仓库里的文件，没有仓库算不出来。'
        Write-Host '首次安装的真实动作会是：' -ForegroundColor Cyan
        Write-Host ('  1. git clone --depth 1 ' + $RepoUrl + ' "' + $InstallDir + '"') -ForegroundColor DarkGray
        Write-Host '  2. 把运行时依赖联接进 node_modules\@deepseek-ai\' -ForegroundColor DarkGray
        Write-Host '  3. node .\sync-presets.mjs 生成 cordis.patch.yml' -ForegroundColor DarkGray
        Write-Host '  4. 在 profile 的 dependencies 与 bundles 里挂上本包' -ForegroundColor DarkGray
        Write-Host '  5. pnpm install' -ForegroundColor DarkGray
        return
    } else {
        $parent = Split-Path $InstallDir -Parent
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        # GitHub 直连会偶发被重置，重试三次再放弃。
        $attempts = 3
        for ($i = 1; $i -le $attempts; $i++) {
            $cloneOut = git clone --depth 1 $RepoUrl $InstallDir 2>&1
            if ($LASTEXITCODE -eq 0) { break }
            if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue }
            Warn ("克隆失败：{0}" -f (@($cloneOut) | Select-Object -Last 1))
            if ($i -lt $attempts) {
                Warn ("{0} 秒后重试（{1}/{2}）" -f (2 * $i), $i, $attempts)
                Start-Sleep -Seconds (2 * $i)
            }
        }
        if ($LASTEXITCODE -ne 0) {
            Fail "git clone 三次都失败。网络不稳时手动克隆 $RepoUrl 到 $InstallDir，再重跑本脚本并加 -Repo `"$InstallDir`"。"
        }
        Ok "已克隆：$InstallDir"
    }
    $Repo = $InstallDir
}

Ok "仓库：$Repo"

Step '定位 dsh 安装目录'

function Test-DshApp([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return Test-Path (Join-Path $Path 'node_modules\@deepseek-ai')
}

if (-not (Test-DshApp $DshApp)) {
    if (-not [string]::IsNullOrWhiteSpace($DshApp)) {
        Warn "指定的目录不像 dsh 安装位置：$DshApp，改为自动探测"
    }
    $candidates = New-Object System.Collections.Generic.List[string]

    # 一、从正在运行的 dsh 进程反推
    foreach ($proc in (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*dsh*' })) {
        try {
            $exe = $proc.Path
            if ($exe) {
                $dir = Split-Path $exe -Parent
                foreach ($guess in @($dir, (Join-Path $dir 'resources\app\dsh'))) {
                    if (Test-DshApp $guess) { $candidates.Add($guess) }
                }
            }
        } catch { }
    }

    # 二、常见安装位置
    foreach ($guess in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\dsh\resources\app\dsh'),
        (Join-Path $env:LOCALAPPDATA 'Programs\dsh'),
        (Join-Path $env:ProgramFiles 'dsh\resources\app\dsh'),
        'D:\soft\dsh desk\resources\app\dsh',
        'D:\soft\dsh\resources\app\dsh'
    )) {
        if (Test-DshApp $guess) { $candidates.Add($guess) }
    }

    $DshApp = $candidates | Select-Object -First 1
}

if (-not (Test-DshApp $DshApp)) {
    Fail "找不到 dsh 安装目录（需要其中存在 node_modules\@deepseek-ai）。
用 -DshApp 指定，例如：.\install.ps1 -DshApp 'D:\soft\dsh desk\resources\app\dsh'"
}
Ok "dsh：$DshApp"

Step '建立运行时依赖的目录联接'

$linkRoot = Join-Path $Repo 'node_modules\@deepseek-ai'
$srcRoot = Join-Path $DshApp 'node_modules\@deepseek-ai'
if (-not (Test-Path $linkRoot)) {
    if ($DryRun) { Warn "将创建目录：$linkRoot" } else { New-Item -ItemType Directory -Path $linkRoot -Force | Out-Null }
}

$linked = 0
$missing = New-Object System.Collections.Generic.List[string]
foreach ($pkg in $linkedPackages) {
    $target = Join-Path $srcRoot $pkg
    $link = Join-Path $linkRoot $pkg
    if (-not (Test-Path $target)) { $missing.Add($pkg); continue }
    if ($DryRun) {
        Warn "将联接：$pkg"
        continue
    }
    if (Test-Path $link) {
        $item = Get-Item $link -Force
        if ($item.LinkType -eq 'Junction' -and @($item.Target) -contains $target) { $linked++; continue }
        Remove-Item $link -Recurse -Force
    }
    New-Item -ItemType Junction -Path $link -Target $target -Force | Out-Null
    $linked++
}
Ok "已联接 $linked 个包"
if ($missing.Count -gt 0) {
    Warn ("dsh 里没有这些包（可能版本不同，跳过）：{0}" -f ($missing -join ', '))
}

Step '生成 cordis.patch.yml'

$syncScript = Join-Path $Repo 'sync-presets.mjs'
if (-not (Test-Path $syncScript)) { Fail "找不到 sync-presets.mjs：$syncScript" }
if ($DryRun) {
    Warn "将执行：node .\sync-presets.mjs（DSH_CHECKOUT=$DshApp）"
} else {
    $env:DSH_CHECKOUT = $DshApp
    try {
        Push-Location $Repo
        node .\sync-presets.mjs
        if ($LASTEXITCODE -ne 0) { Fail "sync-presets.mjs 退出码 $LASTEXITCODE" }
    } finally {
        Remove-Item Env:\DSH_CHECKOUT -ErrorAction SilentlyContinue
        Pop-Location
    }
    Ok 'cordis.patch.yml 已生成'
}

Step '把本包挂进 profile'

$profileJson = Get-Content $profileFile -Raw -Encoding UTF8 | ConvertFrom-Json
$linkSpec = 'link:' + ($Repo -replace '\\', '/')

$needDependency = $true
if ($profileJson.PSObject.Properties.Name -contains 'dependencies' -and $profileJson.dependencies) {
    $existing = $profileJson.dependencies.'dsh-compact-codex'
    if ($existing -eq $linkSpec) { $needDependency = $false }
} else {
    $profileJson | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}

$bundles = @()
if ($profileJson.dsh -and $profileJson.dsh.profile -and $profileJson.dsh.profile.bundles) {
    $bundles = @($profileJson.dsh.profile.bundles)
}
$needBundle = -not ($bundles -contains 'dsh-compact-codex')

if (-not $needDependency -and -not $needBundle) {
    Ok 'profile 里已经挂好，无需改动'
} elseif ($DryRun) {
    if ($needDependency) { Warn "将在 dependencies 写入：dsh-compact-codex = $linkSpec" }
    if ($needBundle) { Warn '将在 bundles 末尾追加：dsh-compact-codex' }
} else {
    $backup = "$profileFile.bak-compact-codex-$stamp"
    Copy-Item $profileFile $backup -Force
    Ok "已备份：$backup"

    if ($needDependency) {
        $profileJson.dependencies | Add-Member -NotePropertyName 'dsh-compact-codex' -NotePropertyValue $linkSpec -Force
        Ok "dependencies += dsh-compact-codex ($linkSpec)"
    }

    if ($needBundle) {
        $order = @()
        if ($profileJson.dsh -and $profileJson.dsh.profile) { $order = @($profileJson.dsh.profile.bundles) }
        $list = @($order) + @('dsh-compact-codex')
        if ($profileJson.dsh) {
            if ($profileJson.dsh.profile) {
                $profileJson.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $list -Force
            } else {
                $profileJson.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = $list }) -Force
            }
        } else {
            $profileJson | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = $list } }) -Force
        }
        Ok 'bundles += dsh-compact-codex（追加在末尾，确保排在 @deepseek-ai/dsh-web-app 之后）'
    }

    # 5.1 的 Set-Content -Encoding UTF8 会写 BOM，JSON.parse 遇到 BOM 会直接抛错。
    $jsonText = $profileJson | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($profileFile, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
    Ok "已写回：$profileFile"
}

Step '安装 profile 依赖'

if ($SkipPnpm) {
    Warn '按参数跳过 pnpm install'
} elseif ($DryRun) {
    Warn "将执行：pnpm install（在 $profileDir）"
} else {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -eq $pnpm) {
        Warn ('找不到 pnpm。手动执行：cd "' + $profileDir + '"; pnpm install')
    } else {
        $lockFile = Join-Path $profileDir 'pnpm-lock.yaml'
        if (Test-Path $lockFile) {
            $lockBackup = "$lockFile.bak-compact-codex-$stamp"
            Copy-Item $lockFile $lockBackup -Force
            Ok "已备份：$lockBackup"
        }
        Push-Location $profileDir
        try {
            pnpm install
            if ($LASTEXITCODE -ne 0) { Fail "pnpm install 退出码 $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
        Ok 'pnpm install 完成'
    }
}

Write-Host ''
if ($DryRun) {
    Write-Host '试运行结束：没有改动任何文件。' -ForegroundColor Yellow
} else {
    Write-Host '安装完成。重启 dsh 后生效。' -ForegroundColor Green
    Write-Host ''
    Write-Host '卸载：把 profile 的 dsh.profile.bundles 里 dsh-compact-codex 移除，' -ForegroundColor DarkGray
    Write-Host '      再 pnpm install 一次，官方 compaction-basic 完整恢复。' -ForegroundColor DarkGray
}
