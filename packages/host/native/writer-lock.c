/* macOS-only N-API bridge. The Node writer owns the fd; no helper or PID locking.
 * No path, database, subprocess, logging or unlock operation is exposed here.
 */
#include <node_api.h>
#include <sys/file.h>
#include <fcntl.h>
#include <errno.h>

static napi_value try_lock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], result;
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "lock fd must be a nonnegative integer");
    return NULL;
  }
  /* Never let an exec'ed descendant prolong the writer's lock lifetime. */
  int flags = fcntl(fd, F_GETFD);
  if (flags == -1 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == -1) {
    napi_throw_error(env, "lock_fd_failed", "lock descriptor unavailable");
    return NULL;
  }
  int rc = flock(fd, LOCK_EX | LOCK_NB);
  if (rc == -1 && errno != EWOULDBLOCK && errno != EAGAIN && errno != EINTR) {
    napi_throw_error(env, "lock_syscall_failed", "OS lock operation failed");
    return NULL;
  }
  napi_get_boolean(env, rc == 0, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "tryLock", NAPI_AUTO_LENGTH, try_lock, NULL, &fn);
  napi_set_named_property(env, exports, "tryLock", fn);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
