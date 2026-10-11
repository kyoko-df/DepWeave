#include <sys/attr.h>
#include <sys/clonefile.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <copyfile.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdio.h>

int dw_open(const char *path) {
    /* macOS rejects combining O_NOFOLLOW with O_NOFOLLOW_ANY. The latter
       covers the final component as well as the ancestors. */
    return open(path, O_RDONLY | O_NOFOLLOW_ANY | O_CLOEXEC);
}
int dw_clone(int source_fd, int dir_fd, const char *name) {
    return fclonefileat(source_fd, dir_fd, name, CLONE_ACL);
}
int dw_exchange(int dir_fd, const char *a, const char *b) {
    return renameatx_np(dir_fd, a, dir_fd, b, RENAME_SWAP);
}
int dw_metadata(int from, int to) {
    /* clone metadata belongs to the source. Remove its xattrs before restoring
       the original target's full metadata, including ACL and resource fork. */
    ssize_t count = flistxattr(to, NULL, 0, 0);
    if (count < 0) return -1;
    if (count > 0) {
        char *names = malloc((size_t)count);
        if (!names) { errno = ENOMEM; return -1; }
        ssize_t got = flistxattr(to, names, (size_t)count, 0);
        if (got < 0) { free(names); return -1; }
        for (ssize_t i = 0; i < got;) {
            const char *name = names + i;
            i += (ssize_t)strlen(name) + 1;
            if (fremovexattr(to, name, 0) < 0) { free(names); return -1; }
        }
        free(names);
    }
    if (fcopyfile(from, to, NULL, COPYFILE_METADATA) < 0) return -1;
    struct stat s;
    if (fstat(from, &s) < 0) return -1;
    struct timespec times[2] = {s.st_atimespec, s.st_mtimespec};
    if (futimens(to, times) < 0) return -1;
    struct attrlist attrs = {0};
    attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
    attrs.commonattr = ATTR_CMN_CRTIME;
    return fsetattrlist(to, &attrs, &s.st_birthtimespec, sizeof(s.st_birthtimespec), 0);
}
int dw_volume(const char *path, uint64_t *available) {
    struct statfs fs;
    if (statfs(path, &fs) < 0) return -1;
    *available = (uint64_t)fs.f_bavail * fs.f_bsize;
    return strcmp(fs.f_fstypename, "apfs") == 0 ? 1 : 0;
}
int dw_storage(int fd, uint64_t *private_size, uint64_t *clone_id) {
    struct attrlist a = {0};
    a.bitmapcount = ATTR_BIT_MAP_COUNT;
    a.commonattr = ATTR_CMN_RETURNED_ATTRS;
    a.forkattr = ATTR_CMNEXT_PRIVATESIZE | ATTR_CMNEXT_CLONEID;
    struct __attribute__((packed, aligned(4))) {
        uint32_t length;
        attribute_set_t returned;
        uint64_t private_size;
        uint64_t clone_id;
    } data = {0};
    if (fgetattrlist(fd, &a, &data, sizeof(data), FSOPT_ATTR_CMN_EXTENDED | FSOPT_PACK_INVAL_ATTRS) < 0) return -1;
    if ((data.returned.forkattr & a.forkattr) != a.forkattr) { errno = ENOTSUP; return -1; }
    *private_size = data.private_size;
    *clone_id = data.clone_id;
    return 0;
}
