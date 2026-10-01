Proton VPN — WireGuard server configs (US and Canada) go in THIS folder.

HOW TO FILL IT
1. Sign in at https://account.protonvpn.com  ->  Downloads
      (or Account -> WireGuard configuration)
2. Platform: Windows (Router / GNU-Linux also work; any full "0.0.0.0/0" config).
   Options: NetShield "Block malware only", Moderate NAT off, NAT-PMP off,
   VPN Accelerator on. IPv6 on or off makes no measurable difference.
   Prefer servers showing a LOW load %.
3. For each server you want in the rotation:
      - pick the server, generate the config, download the .conf
      - save it into this folder (M:\jjj\vpn-configs\)
4. Spread them over many cities. Exits on the same server or the same /24
   network count as ONE place: Instagram walls them together, and the
   rotation treats them as siblings (dev1068).

ONLY THIS FOLDER IS READ
   Sub-folders are ignored, so a sub-folder (e.g. retired\) is the place to
   park a .conf you want out of the rotation without deleting it.

NAMING
   Anything is fine — the rotator stages each pick under a fixed internal name,
   so long/odd filenames don't matter. A short descriptive name just makes the
   log easier to read, e.g.  US-NY-04.conf, US-CA-11.conf, CA-89.conf

SECURITY
   These .conf files contain your PRIVATE KEY. This folder is gitignored and is
   never committed. Don't share the files.

USAGE
   vpn-rotate.bat          switch to a different server (run every ~18 downloads)
   vpn-rotate-setup.bat    run ONCE so switches are silent (no admin popup)
