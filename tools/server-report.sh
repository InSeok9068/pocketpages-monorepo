bash <<'EOF'

section() {
  echo
  echo "============================================================"
  echo "$1"
  echo "============================================================"
}

subsection() {
  echo
  echo "------------------------------------------------------------"
  echo "$1"
  echo "------------------------------------------------------------"
}

exists() {
  command -v "$1" >/dev/null 2>&1
}

section "AI SERVER REPORT"

echo "Generated : $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Hostname  : $(hostname)"
echo "User      : $(whoami)"

section "1. SYSTEM"

grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release 2>/dev/null

echo
echo "[Kernel]"
uname -srmo

echo
echo "[Uptime]"
uptime -p 2>/dev/null || uptime

echo
echo "[Load Average]"
cat /proc/loadavg

section "2. CPU"

if exists lscpu; then
  lscpu | grep -E \
    '^(Architecture|CPU\(s\)|Model name|Thread\(s\) per core|Core\(s\) per socket|Socket\(s\)):'
fi

section "3. MEMORY / SWAP"

free -h

section "4. FILESYSTEM"

subsection "Disk Usage"

df -hT \
  -x tmpfs \
  -x devtmpfs \
  -x squashfs

subsection "Inode Usage"

df -ih \
  -x tmpfs \
  -x devtmpfs \
  -x squashfs

section "5. BLOCK DEVICES"

if exists lsblk; then
  lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS
fi

section "6. DIRECTORY DISK USAGE"

echo "루트 디렉터리별 사용량"

timeout 60s \
  du -x -h --max-depth=1 / 2>/dev/null \
  | sort -h

section "7. IMPORTANT DIRECTORY DETAILS"

for DIR in /var /home /opt /srv /usr/local; do
  if [ -d "$DIR" ]; then
    subsection "$DIR"

    timeout 30s \
      du -x -h --max-depth=1 "$DIR" 2>/dev/null \
      | sort -h
  fi
done

section "8. JOURNAL"

subsection "Journal Disk Usage"

if exists journalctl; then
  journalctl --disk-usage 2>&1
fi

subsection "Recent Errors"

if exists journalctl; then
  journalctl \
    -p 3 \
    -n 30 \
    --no-pager \
    2>&1
fi

section "9. SYSTEMD FAILED"

if exists systemctl; then
  systemctl \
    --failed \
    --no-pager \
    --no-legend \
    2>&1
fi

section "10. LISTENING PORTS"

if exists ss; then
  ss -lntup 2>&1
fi

section "11. DOCKER"

if exists docker; then

  subsection "Containers"

  docker ps -a \
    --size \
    --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Size}}' \
    2>&1

  subsection "Docker Disk Usage"

  docker system df 2>&1

else
  echo "Docker is not installed."
fi

section "12. PACKAGE UPDATE STATUS"

if exists apt; then
  echo "Upgradable packages:"
  apt list --upgradable 2>/dev/null \
    | tail -n +2 \
    | wc -l
fi

section "13. REBOOT REQUIRED"

if [ -f /var/run/reboot-required ]; then
  echo "YES"
else
  echo "NO"
fi

section "14. LARGE LOG FILES"

echo "50MB 이상 로그 파일"

find /var/log \
  -xdev \
  -type f \
  -size +50M \
  -printf '%s %p\n' \
  2>/dev/null \
  | sort -nr \
  | head -n 30 \
  | awk '{
      size=$1;
      $1="";
      printf "%.2f MB%s\n", size/1024/1024, $0
    }'

section "15. QUICK SUMMARY"

echo "[Disk]"
df -h /

echo
echo "[Memory]"
free -h | grep -E '^(Mem|Swap)'

echo
echo "[Journal]"
journalctl --disk-usage 2>/dev/null || true

echo
echo "[Failed Services]"
systemctl --failed --no-legend 2>/dev/null | wc -l

if exists docker; then
  echo
  echo "[Docker]"
  docker system df 2>/dev/null
fi

section "END OF REPORT"

EOF
