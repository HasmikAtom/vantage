package main

import (
	"fmt"
	"os/user"
	"strconv"
)

// resolveOwnerGroup turns the user-supplied owner/group strings into
// numeric IDs ready for the rooted chown helpers. "" or "-1" mean
// "leave this side alone" and become -1 in the syscall.
//
// Either side can be supplied as a user/group NAME (looked up via
// /etc/passwd / /etc/group — which inside the container is bind-mounted
// from the host) or a numeric ID as a string. We resolve names first so
// a numeric-looking username (e.g. "1000" if a user is genuinely called
// that) is still treated as a name. The fallback to numeric only kicks
// in when the name lookup fails.
func resolveOwnerGroup(owner, group string) (uid, gid int, err error) {
	uid = -1
	gid = -1
	if owner != "" && owner != "-1" {
		if u, err := user.Lookup(owner); err == nil {
			n, err := strconv.Atoi(u.Uid)
			if err != nil {
				return 0, 0, fmt.Errorf("user %q: bad uid %q", owner, u.Uid)
			}
			uid = n
		} else if n, perr := strconv.Atoi(owner); perr == nil {
			uid = n
		} else {
			return 0, 0, fmt.Errorf("unknown user %q", owner)
		}
	}
	if group != "" && group != "-1" {
		if g, err := user.LookupGroup(group); err == nil {
			n, err := strconv.Atoi(g.Gid)
			if err != nil {
				return 0, 0, fmt.Errorf("group %q: bad gid %q", group, g.Gid)
			}
			gid = n
		} else if n, perr := strconv.Atoi(group); perr == nil {
			gid = n
		} else {
			return 0, 0, fmt.Errorf("unknown group %q", group)
		}
	}
	return uid, gid, nil
}
