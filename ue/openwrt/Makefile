# OpenWRT package Makefile for the TSN-5G UE Console.
#
# Drop this directory into an OpenWRT feed (or symlink from package/tsn5g-ue),
# then:
#   ./scripts/feeds update -a && ./scripts/feeds install tsn5g-ue
#   make menuconfig        # select Utilities -> tsn5g-ue
#   make package/tsn5g-ue/compile
#
# Produces an .ipk that installs the Python app to /usr/lib/tsn5g-ue, the web UI to
# /www/tsn5g-ue, the config to /etc/tsn5g-ue, and the procd init script.

include $(TOPDIR)/rules.mk

PKG_NAME:=tsn5g-ue
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_LICENSE:=AGPL-3.0-or-later
PKG_MAINTAINER:=AMRC / University of Sheffield

include $(INCLUDE_DIR)/package.mk

define Package/tsn5g-ue
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=TSN-5G UE Console (plug-and-play UE-side app)
  URL:=https://github.com/AMRC-FactoryPlus/tsn5g-ue
  # Runtime deps. Kernel modules provide the modem + TSN scheduler; userspace
  # tools provide QMI control, PTP, and the Python runtime.
  DEPENDS:= \
	+python3-light +python3-yaml +python3-logging +python3-urllib \
	+kmod-usb-net-qmi-wwan +kmod-usb-serial-option +uqmi +libqmi \
	+kmod-sched +tc +linuxptp \
	+iwinfo +ip-full
  PKGARCH:=all
endef

define Package/tsn5g-ue/description
  Plug-and-play, 100% UI-driven application for the UE side of a TSN-over-5G
  system: one-click 5G attach, VXLAN/Ethernet-PDU transport, gPTP time sync, and
  802.1Qbv scheduling to a wired TSN switch.
endef

# Pure-Python + web assets — nothing to cross-compile.
# SRC points at the app checkout (this Makefile lives in <repo>/openwrt).
SRC:=$(CURDIR)/..

define Build/Compile
endef

define Package/tsn5g-ue/install
	# Python package
	$(INSTALL_DIR) $(1)/usr/lib/tsn5g-ue/tsn5g_ue
	$(CP) $(SRC)/tsn5g_ue/* $(1)/usr/lib/tsn5g-ue/tsn5g_ue/
	# Web UI (served by the app's own http server; also browsable via uhttpd)
	$(INSTALL_DIR) $(1)/www/tsn5g-ue
	$(CP) $(SRC)/web/* $(1)/www/tsn5g-ue/
	# Default config (forces the openwrt provider)
	$(INSTALL_DIR) $(1)/etc/tsn5g-ue
	$(INSTALL_CONF) $(SRC)/openwrt/files/tsn5g-ue.config.yaml $(1)/etc/tsn5g-ue/tsn5g-ue.yaml
	# procd init
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) $(SRC)/openwrt/files/tsn5g-ue.init $(1)/etc/init.d/tsn5g-ue
endef

define Package/tsn5g-ue/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/tsn5g-ue enable
	echo "tsn5g-ue installed. Start with: /etc/init.d/tsn5g-ue start"
	echo "Then open http://<ue-ip>:8080/"
}
exit 0
endef

$(eval $(call BuildPackage,tsn5g-ue))
