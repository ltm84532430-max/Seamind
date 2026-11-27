use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use uuid::Uuid;

use crate::python_lab::{discover_conda_env_dirs, PythonVarSummary};

const MAX_R_CODE_BYTES: usize = 120_000;
const R_EXEC_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct REnvInfo {
    pub id: String,
    pub label: String,
    pub rscript_path: String,
    pub env_type: String,
    pub version: Option<String>,
    pub has_tidyverse: bool,
    pub has_ggplot2: bool,
    pub has_data_table: bool,
    pub has_arrow: bool,
    pub has_dbi: bool,
    pub has_duckdb: bool,
    pub has_rpostgres: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct REvalResult {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    pub result_text: String,
    pub images: Vec<String>,
    pub saved_images: Vec<String>,
    pub htmls: Vec<String>,
    pub variables: Vec<PythonVarSummary>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

struct RKernelProcess {
    pid: Option<u32>,
    child: Child,
    stdin: ChildStdin,
    stdout_lines: Lines<BufReader<ChildStdout>>,
}

type SharedRKernel = Arc<tokio::sync::Mutex<RKernelProcess>>;

#[derive(Clone)]
struct RKernelEntry {
    pid: Option<u32>,
    kernel: SharedRKernel,
}

#[derive(Default)]
pub struct RKernelState(Mutex<HashMap<String, RKernelEntry>>);

impl RKernelState {
    pub fn close_all(&self) {
        let entries: Vec<RKernelEntry> = match self.0.lock() {
            Ok(mut guard) => guard.drain().map(|(_, entry)| entry).collect(),
            Err(_) => return,
        };
        for entry in entries {
            if let Some(pid_val) = entry.pid {
                kill_r_pid(pid_val);
            }
            if let Ok(mut guard) = entry.kernel.try_lock() {
                if let Some(pid_val) = guard.pid {
                    kill_r_pid(pid_val);
                }
                let _ = guard.child.start_kill();
            }
        }
    }
}

fn kill_r_pid(pid_val: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid_val.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid_val.to_string()])
            .output();
    }
}

const EMBEDDED_R_DRIVER: &str = r#"
options(width = 120, warn = 1, stringsAsFactors = FALSE)
.sm_helpers <- new.env(parent = globalenv())
.sm_env <- new.env(parent = .sm_helpers)

SEAMIND_BUS_DIR <- Sys.getenv("SEAMIND_BUS_DIR", "")
SEAMIND_TABLES_DIR <- Sys.getenv("SEAMIND_TABLES_DIR", "")
SEAMIND_ARTIFACTS_DIR <- Sys.getenv("SEAMIND_ARTIFACTS_DIR", "")
SEAMIND_DATALAB_BRIDGE_URL <- Sys.getenv("SEAMIND_DATALAB_BRIDGE_URL", "")
SEAMIND_DATALAB_BRIDGE_TOKEN <- Sys.getenv("SEAMIND_DATALAB_BRIDGE_TOKEN", "")
SEAMIND_SESSION_ID <- Sys.getenv("SEAMIND_SESSION_ID", "default")
assign("SEAMIND_BUS_DIR", SEAMIND_BUS_DIR, envir = .sm_helpers)
assign("SEAMIND_TABLES_DIR", SEAMIND_TABLES_DIR, envir = .sm_helpers)
assign("SEAMIND_ARTIFACTS_DIR", SEAMIND_ARTIFACTS_DIR, envir = .sm_helpers)

tryCatch({
  if (.Platform$OS.type == "windows") {
    grDevices::windowsFonts(sans = grDevices::windowsFont("Microsoft YaHei"))
  }
}, error = function(e) NULL)

.sm_safe_name <- function(raw) {
  s <- gsub("[^A-Za-z0-9_]", "_", as.character(raw))
  s <- gsub("^_+|_+$", "", s)
  if (!nzchar(s)) return("table")
  if (grepl("^[0-9]", s)) paste0("t_", s) else s
}

.sm_parse_context_files <- function() {
  if (!nzchar(SEAMIND_BUS_DIR)) return(list())
  ctx_path <- file.path(SEAMIND_BUS_DIR, "context.json")
  if (!file.exists(ctx_path)) return(list())
  if (requireNamespace("jsonlite", quietly = TRUE)) {
    res <- tryCatch(jsonlite::fromJSON(ctx_path, simplifyVector = FALSE), error = function(e) NULL)
    if (!is.null(res) && !is.null(res$mountedFiles)) {
      out <- list()
      for (item in res$mountedFiles) {
        if (!is.null(item$alias) && !is.null(item$path)) {
          out[[as.character(item$alias)]] <- as.character(item$path)
        }
      }
      return(out)
    }
  }
  list()
}

sm_files <- function() .sm_parse_context_files()

.sm_json_escape <- function(s) {
  s <- as.character(s)[1L]
  if (is.na(s)) return("null")
  s <- gsub("\\\\", "\\\\\\\\", s)
  s <- gsub("\"", "\\\\\"", s)
  s <- gsub("\r", "\\\\r", s)
  s <- gsub("\n", "\\\\n", s)
  s <- gsub("\t", "\\\\t", s)
  paste0("\"", s, "\"")
}

.sm_bridge_post <- function(endpoint, body_json) {
  if (!nzchar(SEAMIND_DATALAB_BRIDGE_URL) || !nzchar(SEAMIND_DATALAB_BRIDGE_TOKEN)) {
    stop("Seamind DataLab 本地安全桥接未初始化，请重启 R 内核后重试。")
  }
  url <- paste0(sub("/+$", "", SEAMIND_DATALAB_BRIDGE_URL), endpoint)
  req_file <- tempfile(pattern = "sm_r_req_", fileext = ".json")
  resp_file <- tempfile(pattern = "sm_r_resp_", fileext = ".json")
  on.exit({
    if (file.exists(req_file)) unlink(req_file)
    if (file.exists(resp_file)) unlink(resp_file)
  }, add = TRUE)
  con_out <- file(req_file, open = "wb")
  writeBin(charToRaw(enc2utf8(body_json)), con_out)
  close(con_out)
  curl_bin <- if (.Platform$OS.type == "windows") "curl.exe" else "curl"
  args <- c(
    "-sS", "-X", "POST",
    "-H", "Content-Type: application/json",
    "-H", paste0("Authorization: Bearer ", SEAMIND_DATALAB_BRIDGE_TOKEN),
    "--data-binary", paste0("@", req_file),
    "-o", resp_file,
    url
  )
  status <- suppressWarnings(system2(curl_bin, args = args, stdout = FALSE, stderr = FALSE))
  if (!identical(status, 0L) || !file.exists(resp_file)) {
    stop("调用 Seamind 本地数据库桥接失败（请确认系统可用 curl）。")
  }
  raw_txt <- paste(readLines(resp_file, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  if (requireNamespace("jsonlite", quietly = TRUE)) {
    return(jsonlite::fromJSON(raw_txt, simplifyVector = FALSE))
  }
  stop("解析数据库桥接响应需要 jsonlite 包：install.packages('jsonlite')")
}

sm_dbs <- function() {
  if (!nzchar(SEAMIND_BUS_DIR)) return(list())
  ctx_path <- file.path(SEAMIND_BUS_DIR, "context.json")
  if (!file.exists(ctx_path)) return(list())
  if (requireNamespace("jsonlite", quietly = TRUE)) {
    res <- tryCatch(jsonlite::fromJSON(ctx_path, simplifyVector = FALSE), error = function(e) NULL)
    if (!is.null(res) && !is.null(res$dbConnections)) {
      out <- list()
      for (item in res$dbConnections) {
        nm <- if (!is.null(item$name) && nzchar(as.character(item$name))) as.character(item$name) else as.character(item$id)
        if (nzchar(nm)) out[[nm]] <- item
      }
      return(out)
    }
  }
  list()
}

sm_db_tables <- function(conn_name = NULL, schema = NULL) {
  conn_part <- if (is.null(conn_name)) "null" else .sm_json_escape(conn_name)
  body <- paste0("{\"connection\":", conn_part, ",\"sessionId\":", .sm_json_escape(SEAMIND_SESSION_ID), "}")
  res <- .sm_bridge_post("/db/tables", body)
  if (!isTRUE(res$ok)) {
    stop(if (!is.null(res$error)) res$error else if (!is.null(res$message)) res$message else "读取数据库表列表失败")
  }
  tbls <- res$tables
  if (length(tbls) == 0L) return(data.frame(schema = character(0), table = character(0), type = character(0), estimated_rows = numeric(0)))
  sch_v <- vapply(tbls, function(t) if (!is.null(t$schema)) as.character(t$schema) else "", character(1))
  name_v <- vapply(tbls, function(t) as.character(t$name), character(1))
  type_v <- vapply(tbls, function(t) if (!is.null(t$tableType)) as.character(t$tableType) else "table", character(1))
  rows_v <- vapply(tbls, function(t) {
    v <- if (!is.null(t$estimatedRows)) t$estimatedRows else t$rowCount
    if (is.null(v)) NA_real_ else as.numeric(v)
  }, numeric(1))
  df <- data.frame(schema = sch_v, table = name_v, type = type_v, estimated_rows = rows_v, stringsAsFactors = FALSE)
  if (!is.null(schema) && nzchar(schema)) {
    df <- df[tolower(df$schema) == tolower(schema), , drop = FALSE]
  }
  df
}

sm_db_to_bus <- function(conn_name, sql, bus_name, max_rows = 200000L, read_only = TRUE) {
  ro_lit <- if (isTRUE(read_only)) "true" else "false"
  body <- paste0(
    "{\"connection\":", .sm_json_escape(conn_name),
    ",\"sql\":", .sm_json_escape(sql),
    ",\"busName\":", .sm_json_escape(bus_name),
    ",\"maxRows\":", as.integer(max_rows),
    ",\"readOnly\":", ro_lit,
    ",\"sessionId\":", .sm_json_escape(SEAMIND_SESSION_ID), "}"
  )
  res <- .sm_bridge_post("/db/query-to-bus", body)
  if (!isTRUE(res$ok)) {
    stop(if (!is.null(res$error)) res$error else "数据库查询物化到共享总线失败")
  }
  res
}

sm_db_query <- function(conn_name, sql, limit = 100000L, read_only = TRUE) {
  ro_lit <- if (isTRUE(read_only)) "true" else "false"
  body <- paste0(
    "{\"connection\":", .sm_json_escape(conn_name),
    ",\"sql\":", .sm_json_escape(sql),
    ",\"maxRows\":", as.integer(limit),
    ",\"readOnly\":", ro_lit,
    ",\"sessionId\":", .sm_json_escape(SEAMIND_SESSION_ID), "}"
  )
  res <- .sm_bridge_post("/db/query-to-bus", body)
  if (!isTRUE(res$ok)) {
    stop(if (!is.null(res$error)) res$error else "数据库查询失败")
  }
  target <- as.character(res$path)[1L]
  if (is.na(target) || !nzchar(target) || !file.exists(target)) {
    return(data.frame())
  }
  on.exit(unlink(target), add = TRUE)
  low <- tolower(target)
  if (grepl("\\.parquet$", low)) {
    if (requireNamespace("arrow", quietly = TRUE)) return(as.data.frame(arrow::read_parquet(target)))
    if (requireNamespace("duckdb", quietly = TRUE) && requireNamespace("DBI", quietly = TRUE)) {
      con <- DBI::dbConnect(duckdb::duckdb())
      on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
      qpath <- gsub("'", "''", target, fixed = TRUE)
      return(DBI::dbGetQuery(con, paste0("SELECT * FROM read_parquet('", qpath, "')")))
    }
    stop("读取数据库 Parquet 结果需要 arrow 或 duckdb 包：install.packages('arrow')")
  }
  utils::read.csv(target, check.names = FALSE, fileEncoding = "UTF-8")
}

sm_tables <- function() {
  out <- character(0)
  if (nzchar(SEAMIND_TABLES_DIR) && dir.exists(SEAMIND_TABLES_DIR)) {
    fs <- sort(list.files(SEAMIND_TABLES_DIR, pattern = "\\.(parquet|csv)$", ignore.case = TRUE))
    stems <- unique(sub("\\.[^.]+$", "", fs))
    out <- unique(c(out, stems))
  }
  files <- sm_files()
  if (length(files) > 0L) out <- unique(c(out, names(files)))
  out
}

sm_save <- function(name, df) {
  if (!nzchar(SEAMIND_TABLES_DIR)) stop("SEAMIND_TABLES_DIR 未初始化")
  dir.create(SEAMIND_TABLES_DIR, showWarnings = FALSE, recursive = TRUE)
  safe <- .sm_safe_name(name)
  df_obj <- as.data.frame(df)
  pq_path <- file.path(SEAMIND_TABLES_DIR, paste0(safe, ".parquet"))
  csv_path <- file.path(SEAMIND_TABLES_DIR, paste0(safe, ".csv"))
  if (requireNamespace("arrow", quietly = TRUE)) {
    arrow::write_parquet(df_obj, pq_path)
    if (file.exists(csv_path)) unlink(csv_path)
    return(invisible(pq_path))
  }
  utils::write.csv(df_obj, csv_path, row.names = FALSE, fileEncoding = "UTF-8")
  if (file.exists(pq_path)) unlink(pq_path)
  invisible(csv_path)
}

sm_load <- function(name) {
  safe <- .sm_safe_name(name)
  if (nzchar(SEAMIND_TABLES_DIR) && dir.exists(SEAMIND_TABLES_DIR)) {
    pq_path <- file.path(SEAMIND_TABLES_DIR, paste0(safe, ".parquet"))
    csv_path <- file.path(SEAMIND_TABLES_DIR, paste0(safe, ".csv"))
    if (file.exists(pq_path)) {
      if (requireNamespace("arrow", quietly = TRUE)) {
        return(as.data.frame(arrow::read_parquet(pq_path)))
      }
      if (requireNamespace("duckdb", quietly = TRUE) && requireNamespace("DBI", quietly = TRUE)) {
        con <- DBI::dbConnect(duckdb::duckdb())
        on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
        qpath <- gsub("'", "''", pq_path, fixed = TRUE)
        return(DBI::dbGetQuery(con, paste0("SELECT * FROM read_parquet('", qpath, "')")))
      }
      stop(paste0("检测到 Parquet 共享表 ", pq_path, "，请安装 arrow 或 duckdb 包：install.packages('arrow')"))
    }
    if (file.exists(csv_path)) {
      return(utils::read.csv(csv_path, check.names = FALSE, fileEncoding = "UTF-8"))
    }
  }
  files <- sm_files()
  target <- if (!is.null(files[[name]])) files[[name]] else if (!is.null(files[[safe]])) files[[safe]] else if (file.exists(as.character(name))) as.character(name) else NULL
  if (is.null(target) || !file.exists(target)) {
    stop(paste0("在共享数据总线和已挂载文件中未找到 '", name, "'。当前可用：", paste(sm_tables(), collapse = ", ")))
  }
  low <- tolower(target)
  if (grepl("\\.(parquet|pq)$", low)) {
    if (requireNamespace("arrow", quietly = TRUE)) return(as.data.frame(arrow::read_parquet(target)))
    if (requireNamespace("duckdb", quietly = TRUE) && requireNamespace("DBI", quietly = TRUE)) {
      con <- DBI::dbConnect(duckdb::duckdb())
      on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
      qpath <- gsub("'", "''", target, fixed = TRUE)
      return(DBI::dbGetQuery(con, paste0("SELECT * FROM read_parquet('", qpath, "')")))
    }
    stop("读取 Parquet 需要 arrow 或 duckdb 包：install.packages('arrow')")
  }
  if (grepl("\\.tsv$", low)) {
    return(utils::read.delim(target, check.names = FALSE, fileEncoding = "UTF-8"))
  }
  utils::read.csv(target, check.names = FALSE, fileEncoding = "UTF-8")
}

.sm_extra_images <- character(0)

sm_show_image <- function(path) {
  p <- as.character(path)[1L]
  if (is.na(p) || !nzchar(p) || !file.exists(p)) {
    stop(paste0("未找到图片文件：", p))
  }
  full <- normalizePath(p, winslash = "/", mustWork = FALSE)
  .sm_extra_images <<- unique(c(.sm_extra_images, full))
  invisible(full)
}

assign("sm_files", sm_files, envir = .sm_helpers)
assign("sm_dbs", sm_dbs, envir = .sm_helpers)
assign("sm_db_tables", sm_db_tables, envir = .sm_helpers)
assign("sm_db_query", sm_db_query, envir = .sm_helpers)
assign("sm_db_to_bus", sm_db_to_bus, envir = .sm_helpers)
assign("sm_tables", sm_tables, envir = .sm_helpers)
assign("sm_save", sm_save, envir = .sm_helpers)
assign("sm_load", sm_load, envir = .sm_helpers)
assign("sm_show_image", sm_show_image, envir = .sm_helpers)

.sm_b64_chars <- strsplit("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", "")[[1]]
.sm_b64_map <- rep(-1L, 256L)
for (.i in seq_along(.sm_b64_chars)) {
  .sm_b64_map[as.integer(charToRaw(.sm_b64_chars[.i])) + 1L] <- .i - 1L
}

.sm_b64_encode_raw <- function(raw_bytes) {
  n <- length(raw_bytes)
  if (n == 0L) return("")
  vals <- as.integer(raw_bytes)
  pad <- (3L - (n %% 3L)) %% 3L
  if (pad > 0L) vals <- c(vals, rep(0L, pad))
  m <- matrix(vals, nrow = 3L)
  b1 <- m[1L, ]
  b2 <- m[2L, ]
  b3 <- m[3L, ]
  c1 <- bitwShiftR(b1, 2L)
  c2 <- bitwOr(bitwShiftL(bitwAnd(b1, 3L), 4L), bitwShiftR(b2, 4L))
  c3 <- bitwOr(bitwShiftL(bitwAnd(b2, 15L), 2L), bitwShiftR(b3, 6L))
  c4 <- bitwAnd(b3, 63L)
  out_idx <- as.integer(rbind(c1, c2, c3, c4)) + 1L
  chars <- .sm_b64_chars[out_idx]
  if (pad > 0L) {
    chars[(length(chars) - pad + 1L):length(chars)] <- "="
  }
  paste(chars, collapse = "")
}

.sm_b64_encode_str <- function(txt) {
  if (is.null(txt) || length(txt) == 0L) return("")
  s <- paste(as.character(txt), collapse = "\n")
  if (!nzchar(s)) return("")
  .sm_b64_encode_raw(charToRaw(enc2utf8(s)))
}

.sm_b64_decode_str <- function(b64) {
  b64 <- gsub("[^A-Za-z0-9+/=]", "", b64)
  n <- nchar(b64)
  if (n == 0L) return("")
  raw_c <- as.integer(charToRaw(b64))
  pad <- sum(raw_c == 61L)
  vals <- .sm_b64_map[raw_c + 1L]
  vals[vals < 0L] <- 0L
  m <- matrix(vals, nrow = 4L)
  b1 <- bitwOr(bitwShiftL(m[1L, ], 2L), bitwShiftR(m[2L, ], 4L))
  b2 <- bitwOr(bitwShiftL(bitwAnd(m[2L, ], 15L), 4L), bitwShiftR(m[3L, ], 2L))
  b3 <- bitwOr(bitwShiftL(bitwAnd(m[3L, ], 3L), 6L), m[4L, ])
  out <- as.raw(as.integer(rbind(b1, b2, b3)))
  if (pad > 0L && length(out) >= pad) {
    out <- out[seq_len(length(out) - pad)]
  }
  res <- rawToChar(out)
  Encoding(res) <- "UTF-8"
  res
}

.sm_escape_html <- function(x) {
  s <- as.character(x)
  s <- gsub("&", "&amp;", s, fixed = TRUE)
  s <- gsub("<", "&lt;", s, fixed = TRUE)
  s <- gsub(">", "&gt;", s, fixed = TRUE)
  s
}

.sm_df_to_html <- function(df) {
  max_rows <- min(nrow(df), 50L)
  cols <- colnames(df)
  if (is.null(cols)) cols <- paste0("V", seq_len(ncol(df)))
  th <- paste0("<th>", .sm_escape_html(cols), "</th>", collapse = "")
  rows_html <- character(max_rows)
  if (max_rows > 0L) {
    for (r in seq_len(max_rows)) {
      tds <- vapply(seq_len(ncol(df)), function(c) {
        v <- df[r, c]
        if (is.na(v)) "<td>NA</td>" else paste0("<td>", .sm_escape_html(as.character(v)), "</td>")
      }, character(1L))
      rows_html[r] <- paste0("<tr>", paste(tds, collapse = ""), "</tr>")
    }
  }
  note <- if (nrow(df) > max_rows) {
    paste0("<div style=\"font-size:11px;opacity:0.72;margin-top:4px;\">显示前 ", max_rows, " / 共 ", nrow(df), " 行 × ", ncol(df), " 列</div>")
  } else ""
  paste0("<table class=\"dataframe\"><thead><tr>", th, "</tr></thead><tbody>", paste(rows_html, collapse = ""), "</tbody></table>", note)
}

.sm_collect_vars <- function() {
  nms <- ls(envir = .sm_env, all.names = FALSE)
  if (length(nms) == 0L) return("")
  lines <- character(0)
  for (nm in head(nms, 64L)) {
    val <- tryCatch(get(nm, envir = .sm_env), error = function(e) NULL)
    if (is.function(val)) next
    cls <- paste(class(val), collapse = "/")
    prev <- tryCatch({
      if (is.data.frame(val) || is.matrix(val)) {
        paste0(nrow(val), "x", ncol(val), " [", paste(head(colnames(val), 5L), collapse = ", "), "]")
      } else if (is.atomic(val)) {
        s <- paste(head(as.character(val), 6L), collapse = ", ")
        if (length(val) > 6L) paste0("len=", length(val), " [", substr(s, 1L, 80L), "...]") else substr(s, 1L, 100L)
      } else {
        paste0("len=", length(val))
      }
    }, error = function(e) "<object>")
    clean <- function(z) gsub("[\t\r\n]", " ", as.character(z))
    lines <- c(lines, paste(clean(nm), clean(cls), clean(prev), sep = "\t"))
  }
  paste(lines, collapse = "\n")
}

.sm_con <- file("stdin", open = "r")
repeat {
  line <- tryCatch(readLines(.sm_con, n = 1L, warn = FALSE), error = function(e) character(0))
  if (length(line) == 0L) break
  line <- trimws(line)
  if (!nzchar(line)) next
  parts <- strsplit(line, "|", fixed = TRUE)[[1]]
  op <- parts[1L]
  req_id <- if (length(parts) >= 2L) parts[2L] else ""
  if (op == "SHUTDOWN") break

  if (op == "RESET") {
    rm(list = ls(envir = .sm_env, all.names = TRUE), envir = .sm_env)
    cat(paste("SEAMIND_R_RES", req_id, "1", "", "", "", "", "", "", "", sep = "|"), "\n", sep = "")
    flush.console()
    next
  }

  if (op == "VARS") {
    v_b64 <- .sm_b64_encode_str(.sm_collect_vars())
    cat(paste("SEAMIND_R_RES", req_id, "1", "", "", "", "", "", v_b64, "", sep = "|"), "\n", sep = "")
    flush.console()
    next
  }

  assign("SEAMIND_FILES", sm_files(), envir = .sm_helpers)

  code_b64 <- if (length(parts) >= 3L) parts[3L] else ""
  code_txt <- .sm_b64_decode_str(code_b64)
  ok_flag <- "1"
  out_txt <- ""
  res_txt <- ""
  err_txt <- ""
  html_txt <- ""
  img_b64s <- character(0)
  saved_img_paths <- character(0)

  .sm_extra_images <<- character(0)
  plot_dir <- tempfile("seamind_r_plots_")
  dir.create(plot_dir, showWarnings = FALSE, recursive = TRUE)
  plot_pattern <- file.path(plot_dir, "plot_%03d.png")

  dev_opened <- FALSE
  base_dev_id <- -1L
  tryCatch({
    if (requireNamespace("ragg", quietly = TRUE)) {
      ragg::agg_png(filename = plot_pattern, width = 920, height = 560, res = 128, background = "white")
    } else if (.Platform$OS.type == "windows") {
      tryCatch(
        grDevices::png(filename = plot_pattern, width = 920, height = 560, res = 128, bg = "white", type = "cairo"),
        error = function(e) grDevices::png(filename = plot_pattern, width = 920, height = 560, res = 128, bg = "white")
      )
    } else {
      grDevices::png(filename = plot_pattern, width = 920, height = 560, res = 128, bg = "white")
    }
    base_dev_id <- grDevices::dev.cur()
    if (.Platform$OS.type == "windows") {
      tryCatch(graphics::par(family = "sans"), error = function(e) NULL)
    }
    dev_opened <- TRUE
  }, error = function(e) {
    dev_opened <<- FALSE
  })

  tryCatch({
    exprs <- parse(text = code_txt)
    last_val <- NULL
    last_vis <- FALSE
    out_lines <- capture.output({
      for (ex in exprs) {
        ev <- withVisible(eval(ex, envir = .sm_env))
        last_val <- ev$value
        last_vis <- isTRUE(ev$visible)
        if (inherits(last_val, "ggplot") || inherits(last_val, "patchwork")) {
          if (.Platform$OS.type == "windows" && requireNamespace("ggplot2", quietly = TRUE)) {
            last_val <- tryCatch(
              last_val + ggplot2::theme(text = ggplot2::element_text(family = "sans")),
              error = function(e) last_val
            )
          }
          print(last_val)
          last_vis <- FALSE
        } else if (inherits(last_val, "trellis")) {
          print(last_val)
          last_vis <- FALSE
        } else if (inherits(last_val, "grob") || inherits(last_val, "gtable")) {
          if (requireNamespace("grid", quietly = TRUE)) {
            grid::grid.newpage()
            grid::grid.draw(last_val)
            last_vis <- FALSE
          }
        } else if (
          is.character(last_val) &&
          length(last_val) == 1L &&
          !is.na(last_val) &&
          grepl("\\.(png|jpe?g|webp|gif)$", tolower(last_val)) &&
          file.exists(last_val)
        ) {
          .sm_extra_images <<- unique(c(.sm_extra_images, normalizePath(last_val, winslash = "/", mustWork = FALSE)))
        }
      }
    })
    out_txt <- paste(out_lines, collapse = "\n")
    if (last_vis && !is.null(last_val)) {
      if (is.data.frame(last_val)) {
        html_txt <- .sm_df_to_html(last_val)
      }
      res_lines <- capture.output(print(last_val))
      res_txt <- paste(res_lines, collapse = "\n")
    }
  }, error = function(e) {
    ok_flag <<- "0"
    err_txt <<- conditionMessage(e)
  })

  if (dev_opened && base_dev_id > 1L && (base_dev_id %in% grDevices::dev.list())) {
    tryCatch(grDevices::dev.off(which = base_dev_id), error = function(e) NULL)
  } else if (dev_opened && length(grDevices::dev.list()) > 0L) {
    tryCatch(grDevices::dev.off(), error = function(e) NULL)
  }

  .sm_append_r_img <- function(pf, archive_copy = TRUE) {
    if (!file.exists(pf)) return(invisible(NULL))
    sz <- file.info(pf)$size
    if (is.na(sz) || sz <= 120L || sz > 8L * 1024L * 1024L) return(invisible(NULL))
    low <- tolower(pf)
    mime <- if (grepl("\\.jpe?g$", low)) "image/jpeg" else if (grepl("\\.webp$", low)) "image/webp" else if (grepl("\\.gif$", low)) "image/gif" else "image/png"
    raw_bytes <- readBin(pf, what = "raw", n = sz)
    data_url <- paste0("data:", mime, ";base64,", .sm_b64_encode_raw(raw_bytes))
    if (!(data_url %in% img_b64s) && length(img_b64s) < 12L) {
      img_b64s <<- c(img_b64s, data_url)
      if (archive_copy && nzchar(SEAMIND_ARTIFACTS_DIR)) {
        tryCatch({
          dir.create(SEAMIND_ARTIFACTS_DIR, showWarnings = FALSE, recursive = TRUE)
          ts_ms <- format(as.numeric(Sys.time()) * 1000, digits = 13, scientific = FALSE)
          dest <- file.path(SEAMIND_ARTIFACTS_DIR, paste0("r_plot_", ts_ms, "_", length(img_b64s), ".png"))
          file.copy(pf, dest, overwrite = TRUE)
          saved_img_paths <<- c(saved_img_paths, dest)
        }, error = function(e) NULL)
      } else if (!archive_copy) {
        saved_img_paths <<- unique(c(saved_img_paths, pf))
      }
    }
  }

  plot_files <- sort(list.files(plot_dir, pattern = "\\.png$", full.names = TRUE))
  for (pf in head(plot_files, 8L)) {
    .sm_append_r_img(pf, archive_copy = TRUE)
  }
  for (ep in head(.sm_extra_images, 8L)) {
    .sm_append_r_img(ep, archive_copy = FALSE)
  }
  unlink(plot_dir, recursive = TRUE, force = TRUE)

  v_b64 <- .sm_b64_encode_str(.sm_collect_vars())
  cat(
    paste(
      "SEAMIND_R_RES",
      req_id,
      ok_flag,
      .sm_b64_encode_str(out_txt),
      .sm_b64_encode_str(res_txt),
      .sm_b64_encode_str(err_txt),
      paste(img_b64s, collapse = "^"),
      .sm_b64_encode_str(html_txt),
      v_b64,
      .sm_b64_encode_str(paste(saved_img_paths, collapse = "\n")),
      sep = "|"
    ),
    "\n",
    sep = ""
  )
  flush.console()
}
"#;

fn normalize_r_path_key(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim_start_matches("\\\\?\\");
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn clean_r_display_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_string()
}

struct RPkgFlags {
    has_tidyverse: bool,
    has_ggplot2: bool,
    has_data_table: bool,
    has_arrow: bool,
    has_dbi: bool,
    has_duckdb: bool,
    has_rpostgres: bool,
    version: Option<String>,
}

fn inspect_r_installation(rscript_path: &Path) -> RPkgFlags {
    let mut flags = RPkgFlags {
        has_tidyverse: false,
        has_ggplot2: false,
        has_data_table: false,
        has_arrow: false,
        has_dbi: false,
        has_duckdb: false,
        has_rpostgres: false,
        version: None,
    };

    // Infer R root from .../R-4.x.y/bin/x64/Rscript.exe or .../lib/R/bin/x64/Rscript.exe
    let mut lib_dirs: Vec<PathBuf> = Vec::new();
    for ancestor in rscript_path.ancestors().take(5) {
        let lib = ancestor.join("library");
        if lib.is_dir() {
            lib_dirs.push(lib);
        }
        let lib_r = ancestor.join("lib").join("R").join("library");
        if lib_r.is_dir() {
            lib_dirs.push(lib_r);
        }
        if flags.version.is_none() {
            if let Some(name) = ancestor.file_name().and_then(|n| n.to_str()) {
                if let Some(ver) = name.strip_prefix("R-") {
                    flags.version = Some(ver.to_string());
                }
            }
        }
    }

    // Check user R library directories on Windows
    #[cfg(windows)]
    {
        if let Some(local_app) = std::env::var_os("LOCALAPPDATA") {
            let win_lib = PathBuf::from(local_app).join("R").join("win-library");
            if let Ok(entries) = std::fs::read_dir(win_lib) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        lib_dirs.push(entry.path());
                    }
                }
            }
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            let doc_lib = PathBuf::from(profile)
                .join("Documents")
                .join("R")
                .join("win-library");
            if let Ok(entries) = std::fs::read_dir(doc_lib) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        lib_dirs.push(entry.path());
                    }
                }
            }
        }
    }

    for dir in lib_dirs {
        if dir.join("tidyverse").is_dir() {
            flags.has_tidyverse = true;
        }
        if dir.join("ggplot2").is_dir() {
            flags.has_ggplot2 = true;
        }
        if dir.join("data.table").is_dir() {
            flags.has_data_table = true;
        }
        if dir.join("arrow").is_dir() {
            flags.has_arrow = true;
        }
        if dir.join("DBI").is_dir() {
            flags.has_dbi = true;
        }
        if dir.join("duckdb").is_dir() {
            flags.has_duckdb = true;
        }
        if dir.join("RPostgres").is_dir() {
            flags.has_rpostgres = true;
        }
    }

    flags
}

pub(crate) fn resolve_rscript_executable(raw: &str) -> Option<PathBuf> {
    let trimmed = raw
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_start_matches("\\\\?\\")
        .trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = PathBuf::from(trimmed);
    if p.is_file() {
        return Some(p);
    }
    if p.is_dir() {
        let candidates = [
            p.join("bin").join("x64").join("Rscript.exe"),
            p.join("bin").join("Rscript.exe"),
            p.join("Library").join("bin").join("Rscript.exe"),
            p.join("Library")
                .join("lib")
                .join("R")
                .join("bin")
                .join("x64")
                .join("Rscript.exe"),
            p.join("Scripts").join("Rscript.exe"),
            p.join("bin").join("Rscript"),
            p.join("Rscript.exe"),
            p.join("Rscript"),
        ];
        for cand in candidates {
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

pub(crate) fn apply_r_env_activation(cmd: &mut Command, exe_path: &Path) {
    let mut prepend: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe_path.parent() {
        prepend.push(dir.to_path_buf());
    }

    // Walk ancestors to detect Conda environment or R_HOME
    let mut conda_root: Option<PathBuf> = None;
    let mut r_home: Option<PathBuf> = None;
    let mut cur = exe_path.parent();
    for _ in 0..5 {
        let Some(d) = cur else { break };
        if conda_root.is_none() && d.join("conda-meta").is_dir() {
            conda_root = Some(d.to_path_buf());
        }
        if r_home.is_none()
            && (d.join("etc").join("Renviron").is_file()
                || (d.join("library").is_dir() && d.join("bin").is_dir()))
        {
            r_home = Some(d.to_path_buf());
        }
        cur = d.parent();
    }

    if let Some(ref root) = conda_root {
        let extra = [
            root.clone(),
            root.join("Library").join("mingw-w64").join("bin"),
            root.join("Library").join("usr").join("bin"),
            root.join("Library").join("bin"),
            root.join("Scripts"),
            root.join("bin"),
        ];
        for d in extra {
            if d.is_dir() && !prepend.iter().any(|x| x == &d) {
                prepend.push(d);
            }
        }
        let env_name = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("base")
            .to_string();
        cmd.env("CONDA_PREFIX", root);
        cmd.env("CONDA_DEFAULT_ENV", env_name);
        cmd.env("CONDA_SHLVL", "1");
    }

    if let Some(ref rh) = r_home {
        cmd.env("R_HOME", rh);
    }

    if !prepend.is_empty() {
        let mut combined = prepend;
        if let Some(existing_path) = std::env::var_os("PATH") {
            combined.extend(std::env::split_paths(&existing_path));
        }
        if let Ok(joined) = std::env::join_paths(combined) {
            cmd.env("PATH", joined);
        }
    }
}

pub(crate) fn collect_candidate_r_envs(extra_paths: Option<&[String]>) -> Vec<REnvInfo> {
    let mut seen = HashSet::<String>::new();
    let mut results = Vec::<REnvInfo>::new();

    let mut push_r = |path: PathBuf, label: String, env_type: &str| {
        if !path.is_file() {
            return;
        }
        let key = normalize_r_path_key(&path);
        if !seen.insert(key) {
            return;
        }
        let flags = inspect_r_installation(&path);
        results.push(REnvInfo {
            id: format!("r-{}", results.len() + 1),
            label,
            rscript_path: clean_r_display_path(&path),
            env_type: env_type.to_string(),
            version: flags.version,
            has_tidyverse: flags.has_tidyverse,
            has_ggplot2: flags.has_ggplot2,
            has_data_table: flags.has_data_table,
            has_arrow: flags.has_arrow,
            has_dbi: flags.has_dbi,
            has_duckdb: flags.has_duckdb,
            has_rpostgres: flags.has_rpostgres,
        });
    };

    if let Some(custom_list) = extra_paths {
        for raw in custom_list {
            let Some(p) = resolve_rscript_executable(raw) else {
                continue;
            };
            push_r(p, "自定义 R".to_string(), "custom");
        }
    }

    if let Some(r_home) = std::env::var_os("R_HOME") {
        let base = PathBuf::from(r_home);
        if cfg!(windows) {
            push_r(
                base.join("bin").join("x64").join("Rscript.exe"),
                "R_HOME".to_string(),
                "system",
            );
            push_r(
                base.join("bin").join("Rscript.exe"),
                "R_HOME".to_string(),
                "system",
            );
        } else {
            push_r(base.join("bin").join("Rscript"), "R_HOME".to_string(), "system");
        }
    }

    #[cfg(windows)]
    {
        let mut r_parent_dirs: Vec<PathBuf> = vec![
            PathBuf::from("C:\\Program Files\\R"),
            PathBuf::from("D:\\Program Files\\R"),
            PathBuf::from("C:\\R"),
            PathBuf::from("D:\\R"),
        ];
        if let Some(local_app) = std::env::var_os("LOCALAPPDATA") {
            r_parent_dirs.push(PathBuf::from(local_app).join("Programs").join("R"));
        }
        for parent in r_parent_dirs {
            if let Ok(entries) = std::fs::read_dir(parent) {
                let mut versions: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect();
                versions.sort();
                versions.reverse();
                for dir in versions {
                    let name = dir
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("R")
                        .to_string();
                    let x64 = dir.join("bin").join("x64").join("Rscript.exe");
                    if x64.is_file() {
                        push_r(x64, format!("System {name}"), "system");
                    } else {
                        push_r(dir.join("bin").join("Rscript.exe"), format!("System {name}"), "system");
                    }
                }
            }
        }
    }

    // Conda environments that contain r-base
    for (env_dir, env_name) in discover_conda_env_dirs() {
        if cfg!(windows) {
            let candidates = [
                env_dir.join("lib").join("R").join("bin").join("x64").join("Rscript.exe"),
                env_dir.join("lib").join("R").join("bin").join("Rscript.exe"),
                env_dir.join("Scripts").join("Rscript.exe"),
            ];
            for cand in candidates {
                if cand.is_file() {
                    push_r(cand, format!("Anaconda R · {env_name}"), "conda");
                    break;
                }
            }
        } else {
            let cand = env_dir.join("bin").join("Rscript");
            if cand.is_file() {
                push_r(cand, format!("Anaconda R · {env_name}"), "conda");
            }
        }
    }

    // System PATH Rscript
    let where_cmd = if cfg!(windows) { "where.exe" } else { "which" };
    let args: &[&str] = if cfg!(windows) {
        &["Rscript"]
    } else {
        &["-a", "Rscript"]
    };
    let mut cmd = std::process::Command::new(where_cmd);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let p = PathBuf::from(line.trim());
                let is_conda = line.to_lowercase().contains("conda");
                push_r(
                    p,
                    if is_conda {
                        "Anaconda R".to_string()
                    } else {
                        "System R (PATH)".to_string()
                    },
                    if is_conda { "conda" } else { "system" },
                );
            }
        }
    }

    results
}

fn decode_b64_utf8(input: &str) -> String {
    if input.trim().is_empty() {
        return String::new();
    }
    base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

fn parse_vars_tsv(tsv: &str) -> Vec<PythonVarSummary> {
    let mut out = Vec::new();
    for line in tsv.lines() {
        let mut cols = line.splitn(3, '\t');
        let Some(name) = cols.next().filter(|s| !s.is_empty()) else {
            continue;
        };
        let type_name = cols.next().unwrap_or("object");
        let preview = cols.next().unwrap_or("");
        out.push(PythonVarSummary {
            name: name.to_string(),
            type_name: type_name.to_string(),
            preview: preview.to_string(),
        });
    }
    out
}

async fn spawn_r_kernel(
    rscript_path: &str,
    cwd: Option<&str>,
    session_id: Option<&str>,
) -> Result<RKernelProcess, String> {
    let exe_path = resolve_rscript_executable(rscript_path).ok_or_else(|| {
        format!(
            "无法在路径 ({rscript_path}) 中找到 Rscript 可执行文件。请确认该目录为 R 或 Conda-R 目录，或直接指定 Rscript.exe。"
        )
    })?;
    let exe_display = exe_path.to_string_lossy().to_string();
    let driver_path = std::env::temp_dir().join(format!("seamind_r_driver_{}.R", Uuid::new_v4()));
    std::fs::write(&driver_path, EMBEDDED_R_DRIVER)
        .map_err(|e| format!("写入 R 内核驱动脚本失败：{e}"))?;

    let mut cmd = Command::new(&exe_path);
    cmd.args(["--vanilla", "--slave"])
        .arg(&driver_path);
    apply_r_env_activation(&mut cmd, &exe_path);
    if let Some(dir) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(dir.trim_start_matches("\\\\?\\"));
        if p.is_dir() {
            cmd.current_dir(p);
        }
    }
    if let Ok((sid, bus_dir, tables_dir, artifacts_dir)) =
        crate::data_lab::ensure_session_bus_dirs(session_id)
    {
        cmd.env("SEAMIND_SESSION_ID", sid);
        cmd.env("SEAMIND_BUS_DIR", bus_dir.to_string_lossy().to_string());
        cmd.env(
            "SEAMIND_TABLES_DIR",
            tables_dir.to_string_lossy().to_string(),
        );
        cmd.env(
            "SEAMIND_ARTIFACTS_DIR",
            artifacts_dir.to_string_lossy().to_string(),
        );
    }
    if let Some(bridge) = crate::data_lab_bridge::ensure_datalab_bridge() {
        cmd.env("SEAMIND_DATALAB_BRIDGE_URL", bridge.url);
        cmd.env("SEAMIND_DATALAB_BRIDGE_TOKEN", bridge.token);
    }
    cmd.env("R_DEFAULT_PACKAGES", "datasets,utils,grDevices,graphics,stats,methods");
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 R 内核 ({exe_display}) 失败：{e}"))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 R 内核标准输入。".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 R 内核标准输出。".to_string())?;

    Ok(RKernelProcess {
        pid,
        child,
        stdin,
        stdout_lines: BufReader::new(stdout).lines(),
    })
}

async fn send_r_request(kernel: &SharedRKernel, wire_line: String) -> Result<REvalResult, String> {
    let start = std::time::Instant::now();
    let mut guard = kernel.lock().await;
    guard
        .stdin
        .write_all(wire_line.as_bytes())
        .await
        .map_err(|e| format!("写入 R 内核失败（可能已退出）：{e}"))?;
    guard
        .stdin
        .flush()
        .await
        .map_err(|e| format!("刷新 R 内核输入失败：{e}"))?;

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(R_EXEC_TIMEOUT_SECS);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            if let Some(pid_val) = guard.pid {
                kill_r_pid(pid_val);
            }
            let _ = guard.child.start_kill();
            return Err(format!(
                "R 代码执行超过 {R_EXEC_TIMEOUT_SECS} 秒超时，已终止当前内核。请重启 R 内核。"
            ));
        }
        let read_res = tokio::time::timeout(remaining, guard.stdout_lines.next_line()).await;
        let line = match read_res {
            Ok(Ok(Some(l))) => l,
            Ok(Ok(None)) => return Err("R 内核已意外终止。".to_string()),
            Ok(Err(e)) => return Err(format!("读取 R 内核输出失败：{e}")),
            Err(_) => {
                if let Some(pid_val) = guard.pid {
                    kill_r_pid(pid_val);
                }
                let _ = guard.child.start_kill();
                return Err(format!(
                    "R 代码执行超过 {R_EXEC_TIMEOUT_SECS} 秒超时，已终止当前内核。"
                ));
            }
        };
        if let Some(rest) = line.strip_prefix("SEAMIND_R_RES|") {
            let parts: Vec<&str> = rest.split('|').collect();
            let ok = parts.get(1).copied().unwrap_or("0") == "1";
            let stdout = decode_b64_utf8(parts.get(2).copied().unwrap_or(""));
            let result_text = decode_b64_utf8(parts.get(3).copied().unwrap_or(""));
            let err_str = decode_b64_utf8(parts.get(4).copied().unwrap_or(""));
            let images: Vec<String> = parts
                .get(5)
                .copied()
                .unwrap_or("")
                .split('^')
                .map(str::trim)
                .filter(|s| s.starts_with("data:image/") && s.contains(";base64,"))
                .map(|s| s.to_string())
                .collect();
            let html = decode_b64_utf8(parts.get(6).copied().unwrap_or(""));
            let vars_tsv = decode_b64_utf8(parts.get(7).copied().unwrap_or(""));
            let saved_images: Vec<String> = decode_b64_utf8(parts.get(8).copied().unwrap_or(""))
                .lines()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            return Ok(REvalResult {
                ok,
                stdout,
                stderr: String::new(),
                result_text,
                images,
                saved_images,
                htmls: if html.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![html]
                },
                variables: parse_vars_tsv(&vars_tsv),
                error: if err_str.trim().is_empty() {
                    None
                } else {
                    Some(err_str)
                },
                duration_ms: start.elapsed().as_millis() as u64,
            });
        }
    }
}

#[tauri::command]
pub fn r_kernel_detect_envs(
    extra_paths: Option<Vec<String>>,
) -> Result<Vec<REnvInfo>, String> {
    Ok(collect_candidate_r_envs(extra_paths.as_deref()))
}

#[tauri::command]
pub async fn r_kernel_start(
    state: State<'_, RKernelState>,
    rscript_path: Option<String>,
    cwd: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    let resolved = match rscript_path.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(path) => path,
        None => collect_candidate_r_envs(None)
            .into_iter()
            .next()
            .map(|env| env.rscript_path)
            .ok_or_else(|| "未检测到本地 Rscript 环境，请先安装 R 或在环境面板中手动指定 Rscript.exe。".to_string())?,
    };
    let kernel_id = format!("rk-{}", Uuid::new_v4());
    let proc = spawn_r_kernel(&resolved, cwd.as_deref(), session_id.as_deref()).await?;
    let pid = proc.pid;
    let shared = Arc::new(tokio::sync::Mutex::new(proc));
    state
        .0
        .lock()
        .map_err(|_| "R 内核管理器锁已损坏。".to_string())?
        .insert(kernel_id.clone(), RKernelEntry { pid, kernel: shared });
    Ok(kernel_id)
}

#[tauri::command]
pub async fn r_kernel_eval(
    state: State<'_, RKernelState>,
    kernel_id: String,
    code: String,
) -> Result<REvalResult, String> {
    if code.len() > MAX_R_CODE_BYTES {
        return Err(format!("R 代码超过大小限制（最大 {MAX_R_CODE_BYTES} 字节）。"));
    }
    let kernel = state
        .0
        .lock()
        .map_err(|_| "R 内核管理器锁已损坏。".to_string())?
        .get(&kernel_id)
        .map(|entry| Arc::clone(&entry.kernel))
        .ok_or_else(|| "目标 R 内核不存在或已关闭。".to_string())?;

    let req_id = Uuid::new_v4().to_string();
    let encoded = base64::engine::general_purpose::STANDARD.encode(code.as_bytes());
    send_r_request(&kernel, format!("EXEC|{req_id}|{encoded}\n")).await
}

#[tauri::command]
pub async fn r_kernel_reset(
    state: State<'_, RKernelState>,
    kernel_id: String,
) -> Result<REvalResult, String> {
    let kernel = state
        .0
        .lock()
        .map_err(|_| "R 内核管理器锁已损坏。".to_string())?
        .get(&kernel_id)
        .map(|entry| Arc::clone(&entry.kernel))
        .ok_or_else(|| "目标 R 内核不存在或已关闭。".to_string())?;
    let req_id = Uuid::new_v4().to_string();
    send_r_request(&kernel, format!("RESET|{req_id}\n")).await
}

#[tauri::command]
pub async fn r_kernel_vars(
    state: State<'_, RKernelState>,
    kernel_id: String,
) -> Result<Vec<PythonVarSummary>, String> {
    let kernel = state
        .0
        .lock()
        .map_err(|_| "R 内核管理器锁已损坏。".to_string())?
        .get(&kernel_id)
        .map(|entry| Arc::clone(&entry.kernel))
        .ok_or_else(|| "目标 R 内核不存在或已关闭。".to_string())?;
    let req_id = Uuid::new_v4().to_string();
    let res = send_r_request(&kernel, format!("VARS|{req_id}\n")).await?;
    Ok(res.variables)
}

#[tauri::command]
pub async fn r_kernel_close(
    state: State<'_, RKernelState>,
    kernel_id: String,
) -> Result<(), String> {
    let removed = state
        .0
        .lock()
        .map_err(|_| "R 内核管理器锁已损坏。".to_string())?
        .remove(&kernel_id);
    if let Some(entry) = removed {
        if let Some(pid_val) = entry.pid {
            kill_r_pid(pid_val);
        }
        if let Ok(mut guard) = entry.kernel.try_lock() {
            let _ = guard.child.start_kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_r_driver_uses_caret_delimiter_and_supports_rich_plot_capture() {
        assert!(EMBEDDED_R_DRIVER.contains("collapse = \"^\""));
        assert!(!EMBEDDED_R_DRIVER.contains("paste(img_b64s, collapse = \",\")"));
        assert!(EMBEDDED_R_DRIVER.contains("sm_show_image <- function(path)"));
        assert!(EMBEDDED_R_DRIVER.contains("ragg::agg_png"));
        assert!(EMBEDDED_R_DRIVER.contains("inherits(last_val, \"trellis\")"));
        assert!(EMBEDDED_R_DRIVER.contains("grid::grid.draw(last_val)"));
    }

    #[test]
    fn parses_caret_delimited_r_data_url_images_without_breaking_base64_comma() {
        let img1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let img2 = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/";
        let joined = format!("{img1}^{img2}");
        let parsed: Vec<String> = joined
            .split('^')
            .map(str::trim)
            .filter(|s| s.starts_with("data:image/") && s.contains(";base64,"))
            .map(|s| s.to_string())
            .collect();
        assert_eq!(parsed, vec![img1.to_string(), img2.to_string()]);
    }
}
