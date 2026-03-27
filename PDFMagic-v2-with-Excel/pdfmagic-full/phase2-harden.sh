#!/bin/bash
# =============================================================================
# PHASE 2 — PERMANENT HARDENING: Run after Phase 1 cleanup
# Prevents re-infection and future abuse
# Run as root on 217.217.251.125
# =============================================================================
set -e
LOG="/root/hardening-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

echo "=== Starting hardening: $(date) ==="

# -------------------------------------------------------
# A. REMOVE PHP (you don't need it — your app is Node.js)
# -------------------------------------------------------
echo ""
echo "[A] Removing PHP (CVE-2017-9841 is a PHP vulnerability — Node.js doesn't need PHP)"
apt-get remove --purge -y php* 2>/dev/null || true
apt-get autoremove -y 2>/dev/null || true
# Confirm it's gone
which php 2>/dev/null && echo "WARNING: PHP still present" || echo "PHP removed successfully"

# -------------------------------------------------------
# B. DELETE THE PHPUNIT EXPLOIT FILE IF IT EXISTS
# -------------------------------------------------------
echo ""
echo "[B] Removing any eval-stdin.php files"
find / -path "*/phpunit*eval-stdin.php" -delete 2>/dev/null | grep -v proc || true
find / -path "*/Util/PHP/eval-stdin.php" -delete 2>/dev/null | grep -v proc || true

# -------------------------------------------------------
# C. CLEAN /tmp, /var/tmp, /dev/shm (malware staging areas)
# -------------------------------------------------------
echo ""
echo "[C] Cleaning temporary directories"
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true
# Remount /tmp noexec to prevent execution of downloaded binaries
mount -o remount,noexec,nosuid /tmp 2>/dev/null && echo "/tmp remounted noexec" || echo "/tmp remount skipped (may need fstab update)"

# -------------------------------------------------------
# D. FIREWALL — UFW SETUP (block everything unnecessary)
# -------------------------------------------------------
echo ""
echo "[D] Configuring UFW firewall"
apt-get install -y ufw 2>/dev/null || true

# Reset to defaults
ufw --force reset

# Default: deny all inbound, allow all outbound
ufw default deny incoming
ufw default allow outgoing

# Allow SSH (change 22 to your actual port if different)
ufw allow 22/tcp comment 'SSH'

# Allow HTTP and HTTPS for your web app
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'

# Allow your Node.js app port
ufw allow 3000/tcp comment 'Node.js app'

# Block outbound SSH brute-force (rate limit NEW outbound SSH connections)
# This stops the bot from scanning other servers
ufw route deny out on eth0 to any port 22 2>/dev/null || true

# Enable
ufw --force enable
ufw status verbose
echo "UFW enabled and configured"

# -------------------------------------------------------
# E. SSH HARDENING
# -------------------------------------------------------
echo ""
echo "[E] Hardening SSH config"
SSHD="/etc/ssh/sshd_config"
cp "$SSHD" "${SSHD}.bak.$(date +%Y%m%d)"

# Disable password login — key-only from now on
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD"
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD"
sed -i 's/^#*PermitEmptyPasswords.*/PermitEmptyPasswords no/' "$SSHD"
sed -i 's/^#*X11Forwarding.*/X11Forwarding no/' "$SSHD"
sed -i 's/^#*UseDNS.*/UseDNS no/' "$SSHD"

# Add hardening settings if not present
grep -q "^MaxAuthTries"       "$SSHD" || echo "MaxAuthTries 3"       >> "$SSHD"
grep -q "^LoginGraceTime"     "$SSHD" || echo "LoginGraceTime 30"    >> "$SSHD"
grep -q "^ClientAliveInterval" "$SSHD" || echo "ClientAliveInterval 300" >> "$SSHD"
grep -q "^ClientAliveCountMax" "$SSHD" || echo "ClientAliveCountMax 2"   >> "$SSHD"

# Test config before restarting
sshd -t && systemctl restart sshd && echo "SSH hardened and restarted" || echo "SSH config error — check $SSHD"

# -------------------------------------------------------
# F. INSTALL FAIL2BAN (auto-ban repeated failed SSH logins)
# -------------------------------------------------------
echo ""
echo "[F] Installing and configuring fail2ban"
apt-get install -y fail2ban 2>/dev/null || true

cat > /etc/fail2ban/jail.local <<'FAIL2BAN'
[DEFAULT]
bantime  = 86400
findtime = 600
maxretry = 3
ignoreip = 127.0.0.1/8

[sshd]
enabled  = true
port     = ssh
logpath  = %(sshd_log)s
backend  = %(sshd_backend)s
maxretry = 3
bantime  = 604800

[sshd-ddos]
enabled  = true
port     = ssh
logpath  = %(sshd_log)s
backend  = %(sshd_backend)s
maxretry = 6
findtime = 60
bantime  = 86400
FAIL2BAN

systemctl enable fail2ban
systemctl restart fail2ban
echo "fail2ban configured: bans after 3 failures, 7-day ban"

# -------------------------------------------------------
# G. REMOVE UNAUTHORIZED SSH KEYS
# -------------------------------------------------------
echo ""
echo "[G] Current authorized_keys (review and remove any you don't recognise):"
for f in $(find /root /home -name "authorized_keys" 2>/dev/null); do
  echo "=== $f ==="
  cat "$f"
  echo ""
  echo "To remove all keys and add only yours:"
  echo "  echo 'your-public-key-here' > $f"
  echo "  chmod 600 $f"
done

# -------------------------------------------------------
# H. AUTOMATIC SECURITY UPDATES
# -------------------------------------------------------
echo ""
echo "[H] Enabling unattended security updates"
apt-get install -y unattended-upgrades 2>/dev/null || true
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
echo "Automatic security updates enabled"

# -------------------------------------------------------
# I. SET UP DAILY INTEGRITY MONITORING WITH RKHUNTER
# -------------------------------------------------------
echo ""
echo "[I] Installing rkhunter for ongoing rootkit detection"
apt-get install -y rkhunter 2>/dev/null || true
rkhunter --update 2>/dev/null || true
rkhunter --propupd 2>/dev/null || true  # Baseline current state

# Daily check via cron
cat > /etc/cron.daily/rkhunter-check <<'RKCRON'
#!/bin/bash
/usr/bin/rkhunter --check --skip-keypress --report-warnings-only 2>&1 | mail -s "rkhunter report $(hostname)" root
RKCRON
chmod +x /etc/cron.daily/rkhunter-check
echo "rkhunter baselined — daily scan enabled"

# -------------------------------------------------------
# J. RESPOND TO CONTABO
# -------------------------------------------------------
echo ""
echo "=== HARDENING COMPLETE: $(date) ==="
echo "Log saved to: $LOG"
echo ""
echo "NEXT STEPS:"
echo "  1. Verify your SSH key is still in authorized_keys BEFORE logging out"
echo "  2. Open a new terminal and test SSH login before closing this session"
echo "  3. Email Contabo support with the log file to show remediation steps"
echo "     - Subject: 'Abuse notification remediation - IP 217.217.251.125'"
echo "     - Attach: $LOG"
echo "  4. Check fail2ban is working: fail2ban-client status sshd"
echo "  5. Check UFW rules: ufw status verbose"
