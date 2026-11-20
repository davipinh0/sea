#!/bin/sh
# Preparo de uma VM criada pelo portal, sem o cloud-init.yml. Rodar uma vez na VM:
#   ssh seaadmin@<dominio> 'sh -s' < deploy/azure/prepare-vm.sh
set -eu
USER_NAME=$(id -un)
sudo apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -yq ca-certificates curl unattended-upgrades
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER_NAME"
sudo systemctl enable --now docker
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
sudo mkdir -p /opt/sea /var/backups/sea
sudo chown "$USER_NAME:$USER_NAME" /opt/sea /var/backups/sea
echo "0 3 * * * $USER_NAME /opt/sea/deploy/azure/backup.sh >> /var/backups/sea/backup.log 2>&1" | sudo tee /etc/cron.d/sea-backup >/dev/null
sudo chmod 644 /etc/cron.d/sea-backup
echo "VM preparada."
