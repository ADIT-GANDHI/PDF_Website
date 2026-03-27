#!/bin/bash
# =============================================================================
# SECURITY AUDIT & HARDENING SCRIPT
# Run on production server (217.217.251.125) as root
# Addresses: CVE-2017-9841 outbound exploit traffic + high SSH outbound traffic
# =============================================================================

set -e
LOG="/root/security-audit-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

echo "======================================================"
echo " Security Audit Started: $(date)"
echo "======================================================"

# -------------------------------------------------------
# 1. CHECK FOR SUSPICIOUS OUTBOUND CONNECTIONS
# -------------------------------------------------------
echo -e "\n[1] Active outbound connections:"
ss -tnp state established 2>/dev/null || netstat -tnp 2>/dev/null

echo -e "\n[1b] Connections to external hosts on port 80/443/22 (potential C2 or SSH botnet):"
ss -tnp 2>/dev/null | grep -E ':80 |:443 |:22 ' | grep -v '127\.0\.\|::1' || true

# -------------------------------------------------------
# 2. CHECK RUNNING PROCESSES FOR SUSPICIOUS ACTIVITY
# -------------------------------------------------------
echo -e "\n[2] All running processes (sorted by CPU):"
ps aux --sort=-%cpu | head -40

echo -e "\n[2b] Processes with open network connections:"
lsof -i -P -n 2>/dev/null | grep -E 'ESTABLISHED|LISTEN' | head -40 || true

# -------------------------------------------------------
# 3. CHECK FOR PHP/PHPUNIT (CVE-2017-9841 vector)
# -------------------------------------------------------
echo -e "\n[3] PHP and PHPUnit installations:"
which php 2>/dev/null && php --version || echo "PHP not found in PATH"
find / -name "phpunit" -o -name "phpunit.phar" 2>/dev/null | grep -v "/proc\|node_modules"
find / -name "eval-stdin.php" 2>/dev/null | grep -v "/proc"  # CVE-2017-9841 target file

# -------------------------------------------------------
# 4. CHECK WEB SHELLS / MALICIOUS PHP FILES
# -------------------------------------------------------
echo -e "\n[4] Searching for web shells and suspicious PHP files:"
find /var/www /home /srv /root -name "*.php" 2>/dev/null | while read f; do
  # Look for common web shell signatures
  if grep -lqE 'eval\(base64_decode|system\(.*\$_|exec\(.*\$_|passthru|shell_exec.*\$_GET|assert\(.*\$_' "$f" 2>/dev/null; then
    echo "  [SUSPICIOUS] $f"
  fi
done

# -------------------------------------------------------
# 5. CHECK CRON JOBS FOR PERSISTENCE MECHANISMS
# -------------------------------------------------------
echo -e "\n[5] System cron jobs:"
crontab -l 2>/dev/null || echo "  No root crontab"
ls -la /etc/cron.d/ /etc/cron.hourly/ /etc/cron.daily/ /etc/cron.weekly/ /etc/cron.monthly/ 2>/dev/null
cat /etc/crontab 2>/dev/null

echo -e "\n[5b] User crontabs:"
for user in $(cut -f1 -d: /etc/passwd); do
  crontab -u "$user" -l 2>/dev/null | grep -v '^#' | grep -v '^$' | while read line; do
    echo "  [$user] $line"
  done
done

# -------------------------------------------------------
# 6. CHECK SSH AUTHORIZED KEYS
# -------------------------------------------------------
echo -e "\n[6] SSH authorized_keys files:"
find /root /home -name "authorized_keys" 2>/dev/null | while read f; do
  echo "  === $f ==="
  cat "$f" 2>/dev/null
done

echo -e "\n[6b] SSH config:"
cat /etc/ssh/sshd_config | grep -vE '^#|^$'

# -------------------------------------------------------
# 7. CHECK RECENTLY MODIFIED FILES
# -------------------------------------------------------
echo -e "\n[7] Files modified in last 24 hours (suspicious locations):"
find /tmp /var/tmp /dev/shm /run /var/run -type f -newer /etc/passwd 2>/dev/null | head -30
find /home /root -maxdepth 4 -type f -newer /etc/passwd 2>/dev/null | grep -v '.bash_history\|.cache\|node_modules' | head -20

# -------------------------------------------------------
# 8. CHECK FOR ROOTKITS (if rkhunter/chkrootkit installed)
# -------------------------------------------------------
echo -e "\n[8] Rootkit check:"
if command -v rkhunter &>/dev/null; then
  rkhunter --check --skip-keypress --report-warnings-only 2>/dev/null || true
elif command -v chkrootkit &>/dev/null; then
  chkrootkit 2>/dev/null | grep -v "not infected\|not found" || true
else
  echo "  Installing rkhunter..."
  apt-get install -y rkhunter 2>/dev/null || true
  rkhunter --update 2>/dev/null || true
  rkhunter --check --skip-keypress --report-warnings-only 2>/dev/null || true
fi

# -------------------------------------------------------
# 9. CHECK LISTENING PORTS
# -------------------------------------------------------
echo -e "\n[9] All listening ports:"
ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null

# -------------------------------------------------------
# 10. SSH HARDENING STEPS
# -------------------------------------------------------
echo -e "\n[10] Applying SSH hardening..."

SSHD_CONFIG="/etc/ssh/sshd_config"
cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%Y%m%d)"

# Disable root password login (keep key auth if needed)
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD_CONFIG"
# Disable password authentication
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
# Disable empty passwords
sed -i 's/^#*PermitEmptyPasswords.*/PermitEmptyPasswords no/' "$SSHD_CONFIG"
# Limit max auth tries
grep -q "^MaxAuthTries" "$SSHD_CONFIG" || echo "MaxAuthTries 3" >> "$SSHD_CONFIG"
# Disable X11 forwarding
sed -i 's/^#*X11Forwarding.*/X11Forwarding no/' "$SSHD_CONFIG"
# Client alive interval to detect dead connections
grep -q "^ClientAliveInterval" "$SSHD_CONFIG" || echo "ClientAliveInterval 300" >> "$SSHD_CONFIG"
grep -q "^ClientAliveCountMax" "$SSHD_CONFIG" || echo "ClientAliveCountMax 2" >> "$SSHD_CONFIG"

echo "  SSH config hardened. Restarting SSH..."
systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || true

# -------------------------------------------------------
# 11. INSTALL AND CONFIGURE FAIL2BAN
# -------------------------------------------------------
echo -e "\n[11] Setting up fail2ban for SSH brute force protection..."
apt-get install -y fail2ban 2>/dev/null || true

cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
ignoreip = 127.0.0.1/8

[sshd]
enabled  = true
port     = ssh
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 3
bantime  = 86400
EOF

systemctl enable fail2ban 2>/dev/null || true
systemctl restart fail2ban 2>/dev/null || service fail2ban restart 2>/dev/null || true
echo "  fail2ban configured and started."

# -------------------------------------------------------
# 12. BLOCK OUTBOUND CVE-2017-9841 PROBING (iptables)
# -------------------------------------------------------
echo -e "\n[12] Adding iptables rules to block suspicious outbound traffic patterns..."
# Block outbound connections to common exploit ports if not needed
# Allow established connections, block new outbound on port 80 EXCEPT from nodejs process
# Note: Adjust as needed for your setup

# Rate-limit outbound SSH to prevent botnet use
iptables -A OUTPUT -p tcp --dport 22 -m state --state NEW -m limit --limit 5/min --limit-burst 10 -j ACCEPT 2>/dev/null || true
iptables -A OUTPUT -p tcp --dport 22 -m state --state NEW -j DROP 2>/dev/null || true

echo "  Outbound SSH rate-limited to 5 new connections/minute."
echo "  NOTE: Run 'iptables-save > /etc/iptables/rules.v4' to persist rules."

# -------------------------------------------------------
# SUMMARY
# -------------------------------------------------------
echo -e "\n======================================================"
echo " AUDIT COMPLETE: $(date)"
echo " Log saved to: $LOG"
echo "======================================================"
echo ""
echo " NEXT STEPS:"
echo " 1. Review the log for [SUSPICIOUS] markers above"
echo " 2. Kill any suspicious processes: kill -9 <PID>"
echo " 3. Remove any unauthorized SSH keys from authorized_keys"
echo " 4. Check /tmp, /var/tmp for malicious binaries and delete them"
echo " 5. Consider full OS reinstall if rootkit is confirmed"
echo " 6. Persist iptables: apt-get install iptables-persistent"
echo " 7. Forward logs to external SIEM or enable auditd"
echo " 8. Contact Contabo to report remediation steps taken"
echo "======================================================"
