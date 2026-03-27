#!/bin/bash
# =============================================================================
# PHASE 1 — EMERGENCY KILL: Run this FIRST to stop active malicious traffic
# Run as root on 217.217.251.125
# =============================================================================

echo "=== [1] Finding processes making outbound connections on port 22 and 80 ==="
# Show what's hammering SSH outbound
ss -tnp | grep ':22' | grep -v '127\.0\.\|::1'
lsof -i :22 2>/dev/null | grep -v sshd

echo ""
echo "=== [2] Finding suspicious processes (common bot/miner names) ==="
ps aux | grep -iE 'kthreadd|kworker|xmrig|minerd|masscan|zmap|hydra|medusa|nmap|python.*http|perl.*http|php.*-r|curl.*bash|wget.*bash' | grep -v grep

echo ""
echo "=== [3] Checking /tmp and /var/tmp for malicious binaries ==="
ls -la /tmp/ /var/tmp/ /dev/shm/ 2>/dev/null
find /tmp /var/tmp /dev/shm -type f -executable 2>/dev/null

echo ""
echo "=== [4] Checking for the CVE-2017-9841 PHP file ==="
find / -path "*/phpunit*eval-stdin.php" 2>/dev/null | grep -v proc
find / -path "*/Util/PHP/eval-stdin.php" 2>/dev/null | grep -v proc

echo ""
echo "=== [5] Checking crontabs for persistence ==="
crontab -l 2>/dev/null || echo "No root crontab"
ls -la /var/spool/cron/ 2>/dev/null
for user in $(cut -f1 -d: /etc/passwd); do
  ct=$(crontab -u "$user" -l 2>/dev/null | grep -v '^#' | grep -v '^$')
  [ -n "$ct" ] && echo "[$user]: $ct"
done

echo ""
echo "=== [6] Checking for malicious SSH authorized_keys ==="
for f in $(find /root /home -name "authorized_keys" 2>/dev/null); do
  echo "=== $f ==="; cat "$f"
done

echo ""
echo "=== ACTION REQUIRED: Review output above, then kill suspicious PIDs ==="
echo "  e.g.: kill -9 <PID>   or   pkill -f masscan"
