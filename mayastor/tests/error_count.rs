#[macro_use]
extern crate log;

use std::ffi::CString;
pub mod common;
use mayastor::{
    bdev::nexus_create,
    core::{
        mayastor_env_stop,
        Bdev,
        MayastorCliArgs,
        MayastorEnvironment,
        Reactor,
    },
};

use spdk_sys::{
    create_aio_bdev,
    spdk_vbdev_error_create,
    spdk_vbdev_error_inject_error,
};

static ERROR_COUNT_TEST_NEXUS: &str = "error_count_test_nexus";

static DISKNAME1: &str = "/tmp/disk1.img";
static BDEVNAME1: &str = "aio:///tmp/disk1.img?blk_size=512";

static DISKNAME2: &str = "/tmp/disk2.img";

static CUSTOMNAME: &str = "error_device";
static EE_CUSTOMNAME: &str = "EE_error_device"; // The prefix is added by the vbdev_error module
static BDEV_EE_CUSTOMNAME: &str = "bdev:///EE_error_device";

const VBDEV_IO_FAILURE: u32 = 1;
//const VBDEV_IO_PENDING: u32 = 2;

const SPDK_BDEV_IO_TYPE_READ: u32 = 1;
const SPDK_BDEV_IO_TYPE_WRITE: u32 = 2;

#[test]
fn error_test() {
    common::truncate_file(DISKNAME1, 64 * 1024);
    common::truncate_file(DISKNAME2, 64 * 1024);

    test_init!();

    Reactor::block_on(async {
        create_error_bdev_raw().await;
        create_nexus().await;

        err_write_nexus().await;
        err_read_nexus().await;

        inject_error(SPDK_BDEV_IO_TYPE_WRITE, VBDEV_IO_FAILURE, 1).await;
        err_write_nexus().await;
        err_read_nexus().await;

        inject_error(SPDK_BDEV_IO_TYPE_READ, VBDEV_IO_FAILURE, 1).await;
        err_read_nexus().await; // multiple reads because there are two replicas and we may get the
        err_read_nexus().await; // wrong one
        err_write_nexus().await;
    });
    mayastor_env_stop(0);
}

async fn inject_error(op: u32, mode: u32, count: u32) {
    let retval: i32;
    let err_bdev_name_str =
        CString::new(EE_CUSTOMNAME).expect("Failed to create name string");
    let raw = err_bdev_name_str.into_raw();

    unsafe {
        retval = spdk_vbdev_error_inject_error(raw, op, mode, count);
    }
    assert_eq!(retval, 0);
}

async fn create_error_bdev_raw() {
    let mut retval: i32;
    let cname = CString::new(CUSTOMNAME).unwrap();
    let filename = CString::new(DISKNAME2).unwrap();

    unsafe {
        // this allows us to create a bdev without its name being a uri
        retval = create_aio_bdev(cname.as_ptr(), filename.as_ptr(), 512)
    };
    assert_eq!(retval, 0);

    let err_bdev_name_str = CString::new(CUSTOMNAME.to_string())
        .expect("Failed to create name string");
    unsafe {
        retval = spdk_vbdev_error_create(err_bdev_name_str.as_ptr()); // create the error bdev around it
    }
    assert_eq!(retval, 0);
}

async fn create_nexus() {
    let ch = vec![BDEVNAME1.to_string(), BDEV_EE_CUSTOMNAME.to_string()];

    nexus_create(ERROR_COUNT_TEST_NEXUS, 64 * 1024 * 1024, None, &ch)
        .await
        .unwrap();
}

async fn err_write_nexus() {
    let bdev = Bdev::lookup_by_name(ERROR_COUNT_TEST_NEXUS)
        .expect("failed to lookup nexus");
    let d = bdev
        .open(true)
        .expect("failed open bdev")
        .into_handle()
        .unwrap();
    let buf = d.dma_malloc(512).expect("failed to allocate buffer");

    d.write_at(0, &buf).await.unwrap();
    info!("write done");
}

async fn err_read_nexus() {
    let bdev = Bdev::lookup_by_name(ERROR_COUNT_TEST_NEXUS)
        .expect("failed to lookup nexus");
    let d = bdev
        .open(true)
        .expect("failed open bdev")
        .into_handle()
        .unwrap();
    let mut buf = d.dma_malloc(512).expect("failed to allocate buffer");

    d.read_at(0, &mut buf).await.unwrap();
    info!("read done");
}
