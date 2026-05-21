package main

import "testing"

func TestIsWholeDisk(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		// whole disks
		{"sda", true},
		{"sdb", true},
		{"sdaa", true},
		{"hda", true},
		{"vda", true},
		{"xvda", true},
		{"nvme0n1", true},
		{"nvme0n2", true}, // multi-namespace NVMe — previously broken
		{"nvme1n1", true},
		{"mmcblk0", true},
		{"mmcblk1", true},
		{"sr0", true},
		{"pmem0", true},

		// partitions
		{"sda1", false},
		{"sda12", false},
		{"hda1", false},
		{"vda1", false},
		{"xvda1", false},
		{"nvme0n1p1", false},
		{"nvme0n2p1", false}, // partition on second namespace
		{"mmcblk0p1", false},

		// virtual / pseudo devices we never want
		{"loop0", false},
		{"loop12", false},
		{"ram0", false},
		{"dm-0", false},
		{"dm-15", false},

		// junk
		{"", false},
		{"abc", false},
	}
	for _, c := range cases {
		if got := isWholeDisk(c.name); got != c.want {
			t.Errorf("isWholeDisk(%q) = %v, want %v", c.name, got, c.want)
		}
	}
}
