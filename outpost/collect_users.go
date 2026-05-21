package main

import (
	"bufio"
	"os"
	"sort"
	"strconv"
	"strings"
)

// collectUsers parses /etc/passwd and /etc/group (host paths via etcPath)
// and returns the cross-referenced user/group inventory. Static-ish data —
// callers refresh on the slow tier.
func collectUsers() UsersInfo {
	out := UsersInfo{Users: []User{}, Groups: []Group{}}

	groupsByGID, groupsByName, groups := readGroups(etcPath("group"))
	users := readPasswd(etcPath("passwd"))

	// Resolve each user's group membership: primary group (from gid) plus any
	// supplementary memberships recorded in /etc/group.
	suppByUser := map[string][]string{}
	for _, g := range groups {
		for _, m := range g.Members {
			suppByUser[m] = append(suppByUser[m], g.Name)
		}
	}

	for i := range users {
		u := &users[i]
		primary := ""
		if g, ok := groupsByGID[u.GID]; ok {
			primary = g.Name
		}
		supp := append([]string(nil), suppByUser[u.Username]...)
		sort.Strings(supp)
		// Dedupe primary out of supp so it isn't listed twice.
		filtered := supp[:0]
		for _, name := range supp {
			if name != primary {
				filtered = append(filtered, name)
			}
		}
		if primary != "" {
			u.Groups = append([]string{primary}, filtered...)
		} else {
			u.Groups = filtered
		}
		if u.Groups == nil {
			u.Groups = []string{}
		}
	}

	// Augment each group's member list with users whose primary GID points at
	// it — /etc/group only records *supplementary* memberships, so the primary
	// link has to be reconstructed here.
	primaryMembers := map[int][]string{}
	for _, u := range users {
		primaryMembers[u.GID] = append(primaryMembers[u.GID], u.Username)
	}
	for i := range groups {
		g := &groups[i]
		extra := primaryMembers[g.GID]
		seen := map[string]bool{}
		for _, m := range g.Members {
			seen[m] = true
		}
		for _, m := range extra {
			if !seen[m] {
				g.Members = append(g.Members, m)
				seen[m] = true
			}
		}
		sort.Strings(g.Members)
		if g.Members == nil {
			g.Members = []string{}
		}
	}
	_ = groupsByName

	out.Users = users
	out.Groups = groups
	return out
}

func readPasswd(path string) []User {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	var users []User
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// passwd format: name:passwd:uid:gid:gecos:home:shell
		parts := strings.Split(line, ":")
		if len(parts) < 7 {
			continue
		}
		uid, err := strconv.Atoi(parts[2])
		if err != nil {
			continue
		}
		gid, err := strconv.Atoi(parts[3])
		if err != nil {
			continue
		}
		// GECOS is comma-separated; "Full Name,room,phone,…". Take just the
		// first field as the display name.
		gecos := parts[4]
		if i := strings.IndexByte(gecos, ','); i >= 0 {
			gecos = gecos[:i]
		}
		shell := parts[6]
		// System accounts: UID below 1000 (Debian/Ubuntu convention) or a
		// non-interactive shell. Either heuristic alone misses cases — root
		// has UID 0 *and* bash, while some local service users have UID ≥ 1000
		// but /usr/sbin/nologin.
		system := uid < 1000 || isNologinShell(shell)
		users = append(users, User{
			Username: parts[0],
			UID:      uid,
			GID:      gid,
			Gecos:    gecos,
			Home:     parts[5],
			Shell:    shell,
			System:   system,
		})
	}
	sort.Slice(users, func(i, j int) bool { return users[i].UID < users[j].UID })
	return users
}

func readGroups(path string) (byGID map[int]*Group, byName map[string]*Group, all []Group) {
	byGID = map[int]*Group{}
	byName = map[string]*Group{}

	f, err := os.Open(path)
	if err != nil {
		return byGID, byName, nil
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// group format: name:passwd:gid:member1,member2,...
		parts := strings.Split(line, ":")
		if len(parts) < 4 {
			continue
		}
		gid, err := strconv.Atoi(parts[2])
		if err != nil {
			continue
		}
		members := []string{}
		if parts[3] != "" {
			for _, m := range strings.Split(parts[3], ",") {
				m = strings.TrimSpace(m)
				if m != "" {
					members = append(members, m)
				}
			}
		}
		all = append(all, Group{
			Name:    parts[0],
			GID:     gid,
			Members: members,
		})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].GID < all[j].GID })
	for i := range all {
		byGID[all[i].GID] = &all[i]
		byName[all[i].Name] = &all[i]
	}
	return byGID, byName, all
}

func isNologinShell(shell string) bool {
	switch shell {
	case "/usr/sbin/nologin", "/sbin/nologin", "/bin/false", "/usr/bin/false", "":
		return true
	}
	return false
}
