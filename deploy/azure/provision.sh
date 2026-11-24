#!/bin/sh
# Cria a VM do SEA no Azure (no computador, com o Azure CLI logado).
#   sh deploy/azure/provision.sh <rótulo-dns>
# O endereço fica <rótulo>.centralus.cloudapp.azure.com.
set -eu
LABEL=${1:?informe o rótulo DNS, ex.: sea-recebimento}
AZ=${AZ:-az}
RG=rg-sea
VM=vm-sea
LOCATION=centralus
KEY="$HOME/.ssh/sea_azure"
HERE=$(cd "$(dirname "$0")" && pwd)

[ -f "$KEY" ] || ssh-keygen -t ed25519 -N "" -C "sea-azure" -f "$KEY"
MYIP=$(curl -fsS https://api.ipify.org)

"$AZ" group create -n "$RG" -l "$LOCATION" -o none
"$AZ" vm create -g "$RG" -n "$VM" -l "$LOCATION" \
  --image Ubuntu2404 --size Standard_B2s --os-disk-size-gb 64 \
  --admin-username seaadmin --ssh-key-values "$KEY.pub" \
  --public-ip-sku Standard --public-ip-address-dns-name "$LABEL" \
  --custom-data "$HERE/cloud-init.yml" --nsg-rule NONE -o none

NSG="${VM}NSG"
"$AZ" network nsg rule create -g "$RG" --nsg-name "$NSG" -n web --priority 100 \
  --access Allow --protocol Tcp --direction Inbound --destination-port-ranges 80 443 -o none
# Acesso administrativo só a partir deste computador.
"$AZ" network nsg rule create -g "$RG" --nsg-name "$NSG" -n ssh-admin --priority 110 \
  --access Allow --protocol Tcp --direction Inbound --destination-port-ranges 22 \
  --source-address-prefixes "$MYIP/32" -o none

"$AZ" vm show -d -g "$RG" -n "$VM" --query "{ip: publicIps, dominio: fqdns}" -o table
