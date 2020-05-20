// Test CSI gRPC services of mayastor.
//
// It used to be possible to start this test suite against external mayastor
// instance to verify it. But later we dropped this feature because stage and
// publish volume tests became really unsuitable for this type of operation.
// We could split the test suite in future if we want this functionality at
// least for some tests where it is possible to do.
//
// It is a mess to work with nbd devices. If nbd device is attached to kernel
// then detached and immediately attached again we see all kinds of issues.
// That's why we use a different nbd device for each stage operation so that
// we don't confuse the kernel :-(

'use strict';

const assert = require('chai').assert;
const async = require('async');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const protoLoader = require('@grpc/proto-loader');
// we can't use grpc-kit because we need to connect to UDS and that's currently
// possible only with grpc-uds.
const grpc = require('grpc-uds');
const common = require('./test_common');

var csiSock = common.CSI_ENDPOINT;
var endpoint = common.grpcEndpoint;

// One big malloc bdev which we put lvol store on.
const CONFIG = `
[Malloc]
NumberOfLuns 1
LunSizeInMB  150
BlockSize    4096
`;
// uuid without the last digit
const BASE_UUID = '11111111-0000-0000-0000-00000000000';
// used UUID aliases
const UUID1 = BASE_UUID + '0';
const UUID2 = BASE_UUID + '1';
const UUID3 = BASE_UUID + '2';
const UUID4 = BASE_UUID + '3';
const UUID5 = BASE_UUID + '4';

// UUID not used by any volume
const UNKNOWN_UUID = BASE_UUID + '9';

function createCsiClient (service) {
  const pkgDef = grpc.loadPackageDefinition(
    protoLoader.loadSync(
      path.join(__dirname, '..', 'csi', 'proto', 'csi.proto'),
      {
        // this is to load google/descriptor.proto
        includeDirs: ['./node_modules/protobufjs'],
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
      }
    )
  );
  const proto = pkgDef.csi.v1;
  console.log('Creating client for ', csiSock);
  return new proto[service](csiSock, grpc.credentials.createInsecure());
}

function cleanPublishDir (mountTarget, done) {
  const proc = common.runAsRoot('umount', ['-f', mountTarget]);
  proc.once('close', (code, signal) => {
    try {
      fs.rmdirSync(mountTarget);
    } catch (err) {}

    done();
  });
}

function createPublishDir (mountTarget) {
  fs.mkdirSync(mountTarget);
}

// Returns a callback which verifies that method ended with given grpc error.
function shouldFailWith (code, done) {
  return function (err, res) {
    if (err) {
      assert.equal(err.code, code);
      done();
    } else {
      done(new Error('Succeeded but expected to fail with ' + code));
    }
  };
}

// Get filesystem type for given mount point.
function getFsType (mp) {
  const lines = execSync('mount')
    .toString()
    .trim()
    .split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(' ');
    if (mp === cols[2]) {
      return cols[4];
    }
  }
}

function csiGenericTest () {
  describe('csi', function () {
    this.timeout(10000); // for network tests we need long timeouts

    // Start mayastor and create the lvol configuration needed for testing.
    // NOTE: Don't use mayastor in setup - we test CSI interface and we don't want
    // to depend on correct function of mayastor iface in order to test CSI.
    before((done) => {
      const identityClient = createCsiClient('Identity');
      async.series(
        [
          (next) => {
            common.waitFor((pingDone) => {
            // fix the perms now - we can't do that before because it takes
            // time to csi-agent to create it ..
              common.fixSocketPerms((err) => {
                if (err) {
                  return pingDone(err);
                }
                // use harmless method to test if the mayastor is up and running
                identityClient.probe({}, (err, res) => {
                  if (err) {
                    pingDone(err);
                  } else if (!res.ready.value) {
                    pingDone(new Error('not ready'));
                  } else {
                    pingDone(undefined);
                  }
                });
              });
            }, next);
          }
        ]);

      common.startMayastor(CONFIG);
      common.startMayastorGrpc();
      done();
    });

    // stop mayastor server if it was started by us
    after((done) => {
      async.series(
        [
          (next) => {
            common.stopAll(next);
          }
        ],
        done
      );
    });

    describe('general', function () {
      it('should start even if there is a stale csi socket file', (done) => {
        var client = createCsiClient('Identity');

        async.series(
          [
            (next) => {
              common.restartMayastorGrpc((pingDone) => {
              // fix the perms now - we can't do that before because it takes
              // time to csi-agent to create it ..
                common.fixSocketPerms((err) => {
                  if (err) {
                    return pingDone(err);
                  }
                  // use harmless method to test if it is up and running
                  client.probe({}, pingDone);
                });
              }, next);
            }
          ],
          done
        );
      });
    });

    describe('identity', function () {
      var client;

      before(() => {
        client = createCsiClient('Identity');
      });

      after(() => {
        if (client != null) {
          client.close();
        }
      });

      it('probe', (done) => {
        client.probe({}, (err, res) => {
          if (err) return done(err);
          assert.equal(res.ready.value, true);
          done();
        });
      });

      it('get plugin info', (done) => {
        client.getPluginInfo({}, (err, res) => {
          if (err) return done(err);
          // If you need to change values of any properties here,
          // you must change the moac's csi server code as well!
          assert.equal(res.name, 'io.openebs.csi-mayastor');
          assert.equal(res.vendor_version, '0.1');
          assert.lengthOf(Object.keys(res.manifest), 0);
          done();
        });
      });

      it('get plugin capabilities', (done) => {
        client.getPluginCapabilities({}, (err, res) => {
          if (err) return done(err);
          // If you need to change any capabilities here,
          // you must change the moac's csi server code as well!
          assert.lengthOf(res.capabilities, 2);
          assert.equal(res.capabilities[0].service.type, 'CONTROLLER_SERVICE');
          assert.equal(
            res.capabilities[1].service.type,
            'VOLUME_ACCESSIBILITY_CONSTRAINTS'
          );
          done();
        });
      });
    });

    describe('node', function () {
      var client;

      before(() => {
        client = createCsiClient('Node');
      });

      after(() => {
        if (client != null) {
          client.close();
        }
      });

      it('get info', (done) => {
        client.nodeGetInfo({}, (err, res) => {
          if (err) return done(err);
          assert.equal(
            res.node_id,
            'mayastor://' + common.CSI_ID + '/' + endpoint
          );

          assert.isAbove(
            parseInt(res.max_volumes_per_node, 10),
            1,
            'number of nbd devices should be above 1'
          );
          done();
        });
      });

      it('get capabilities', (done) => {
        client.nodeGetCapabilities({}, (err, res) => {
          if (err) return done(err);
          assert.lengthOf(res.capabilities, 2);
          assert.equal(res.capabilities[0].type, 'rpc');
          assert.equal(res.capabilities[0].rpc.type, 'GET_VOLUME_STATS');
          assert.equal(res.capabilities[1].rpc.type, 'STAGE_UNSTAGE_VOLUME');
          done();
        });
      });
    });
  });
}

function csiProtocolTest (protoname, shareType, timeoutMillis, unknownPublishContext) {
  describe('csi' + ' - ' + protoname, function () {
    this.timeout(timeoutMillis); // for network tests we need long timeouts
    const publishedUris = new Map();

    // Start mayastor and create the lvol configuration needed for testing.
    // NOTE: Don't use mayastor in setup - we test CSI interface and we don't want
    // to depend on correct function of mayastor iface in order to test CSI.
    before((done) => {
      const identityClient = createCsiClient('Identity');

      common.startMayastor(CONFIG);
      common.startMayastorGrpc();

      async.series(
        [
          (next) => {
            common.waitFor((pingDone) => {
            // fix the perms now - we can't do that before because it takes
            // time to csi-agent to create it ..
              common.fixSocketPerms((err) => {
                if (err) {
                  return pingDone(err);
                }
                // use harmless method to test if the mayastor is up and running
                identityClient.probe({}, (err, res) => {
                  if (err) {
                    pingDone(err);
                  } else if (!res.ready.value) {
                    pingDone(new Error('not ready'));
                  } else {
                    pingDone(undefined);
                  }
                });
              });
            }, next);
          },
          (next) => {
            common.dumbCommand(
              'construct_lvol_store',
              { bdev_name: 'Malloc0', lvs_name: 'tpool' },
              next
            );
          },
          (next) => {
            async.times(
              5,
              function (n, next) {
                const uuid = BASE_UUID + n;
                common.dumbCommand(
                  'create_replica',
                  {
                    uuid: uuid,
                    pool: 'tpool',
                    thin: false,
                    size: 25 * 1024 * 1024,
                    share: 0 // "NONE"
                  },
                  next
                );
              },
              next
            );
          },
          (next) => {
            async.times(
              5,
              function (n, next) {
                const uuid = BASE_UUID + n;
                common.dumbCommand(
                  'create_nexus',
                  {
                    uuid: uuid,
                    size: 25 * 1024 * 1024,
                    children: ['bdev:///' + BASE_UUID + n]
                  },
                  next
                );
              },
              next
            );
          },
          (next) => {
            async.times(
              5,
              function (n, next) {
                const uuid = BASE_UUID + n;
                common.dumbCommand(
                  'publish_nexus',
                  {
                    uuid: uuid,
                    key: '',
                    share: shareType
                  },
                  next
                );
              },
              next
            );
          }
        ],
        function (err, stdouts) {
          if (err) {
            identityClient.close();
            done(err);
          } else {
            // Ugh {
            // We do not care about the output of all the
            // commands except publish_nexus.
            // common.dumbCommand does not return stdout,
            // common.mCtl (bad name) does.
            // The last sequence we did, was publish the nexuses
            // so the collection of interest is the last
            // collection in the collection of collections.
            // } Ugh
            const devicePaths = stdouts[stdouts.length - 1];
            for (var n in devicePaths) {
              const tmp = JSON.parse(devicePaths[n]);
              const uuid = BASE_UUID + n;
              // stash the published URIs in a map indexed
              // on the uuid of the volume.
              publishedUris.set(uuid, { uri: tmp.device_path });
            }
            done();
          }
          console.log('publishedUris: ', publishedUris);
        }
      );
    });

    // stop mayastor server if it was started by us
    after((done) => {
      async.series(
        [
          (next) => {
            async.times(
              5,
              function (n, next) {
                const uuid = BASE_UUID + n;
                common.dumbCommand('unpublish_nexus', { uuid: uuid }, next);
              },
              function (err, res) { // eslint-disable-line handle-callback-err
                console.log('Error:', err);
                next();
              }
            );
          },
          (next) => {
            common.stopAll(next);
          }
        ],
        done
      );
    });

    describe('stage and unstage xfs volume', function () {
      var client;
      var mountTarget = '/tmp/target0';

      // get default args for stage op with xfs fs
      function getDefaultArgs () {
        return {
          volume_id: UUID1,
          publish_context: publishedUris.get(UUID1),
          staging_target_path: mountTarget,
          volume_capability: {
            access_mode: {
              mode: 'MULTI_NODE_READER_ONLY'
            },
            mount: {
              fs_type: 'xfs'
            }
          },
          readonly: false,
          secrets: {},
          volume_context: {}
        };
      }

      before((done) => {
        client = createCsiClient('Node');
        cleanPublishDir(mountTarget, () => {
          createPublishDir(mountTarget);
          done();
        });
      });

      after((done) => {
        if (client != null) {
          client.close();
        }
        cleanPublishDir(mountTarget, done);
      });

      it('should be able to stage volume (xfs)' + ' - ' + protoname, (done) => {
        client.nodeStageVolume(getDefaultArgs(), (err) => {
          if (err) return done(err);
          assert.equal(getFsType(mountTarget), 'xfs');
          done();
        });
      });

      it('get volume stats' + ' - ' + protoname, (done) => {
        client.nodeGetVolumeStats(
          {
            volume_id: UUID1,
            volume_path: mountTarget
          },
          (err, res) => {
            if (err) return done(err);
            assert.lengthOf(res.usage, 1);
            assert.equal(res.usage[0].unit, 'BYTES');
            // 25MB size of the bdev - something for the metadata
            assert.equal(res.usage[0].total, 24096768);
            // TODO: These are not available yet:
            // assert.equal(res.usage[0].available, 1);
            // assert.equal(res.usage[0].used, 0);
            done();
          }
        );
      });

      it('staging the same volume again should return ok (idempotent)' + ' - ' + protoname, (done) => {
        client.nodeStageVolume(getDefaultArgs(), done);
      });

      it('staging a volume with a non existing bdev should fail with Internal Error' + ' - ' + protoname, (done) => {
        const args = getDefaultArgs();
        args.volume_id = UNKNOWN_UUID;
        args.publish_context = unknownPublishContext;

        client.nodeStageVolume(args, shouldFailWith(grpc.status.NOT_FOUND, done));
      });

      it('staging a volume with the same staging path but with a different bdev should fail' + ' - ' + protoname, (done) => {
        const args = getDefaultArgs();
        args.volume_id = UUID2;
        args.publish_context = publishedUris.get(UUID2);

        client.nodeStageVolume(
          args,
          shouldFailWith(grpc.status.ALREADY_EXISTS, done)
        );
      });

      it('should fail to stage a volume with the bdev using a different target path' + ' - ' + protoname, (done) => {
        const args = getDefaultArgs();
        args.staging_target_path = '/tmp/hello_world';
        client.nodeStageVolume(
          args,
          shouldFailWith(grpc.status.ALREADY_EXISTS, done)
        );
      });

      it('should not unstage a volume with an unknown volumeid and return NOTFOUND error' + ' - ' + protoname, (done) => {
        client.nodeUnstageVolume(
          {
            volume_id: 'illegal',
            staging_target_path: mountTarget
          },
          shouldFailWith(grpc.status.NOT_FOUND, done)
        );
      });

      it('should fail to stage a volume with a missing volume ID' + ' - ' + protoname, (done) => {
        const args = getDefaultArgs();
        delete args.volume_id;
        client.nodeStageVolume(
          args,
          shouldFailWith(grpc.status.INVALID_ARGUMENT, done)
        );
      });

      it('should fail to stage a volume with a missing stage target path' + ' - ' + protoname, (done) => {
        const args = getDefaultArgs();
        delete args.staging_target_path;
        client.nodeStageVolume(
          args,
          shouldFailWith(grpc.status.INVALID_ARGUMENT, done)
        );
      });

      it('should fail to stage a volume with missing access type' + ' - ' + protoname, (done) => {
        const args = getDefaultArgs();
        delete args.volume_capability.mount;
        client.nodeStageVolume(
          args,
          shouldFailWith(grpc.status.INVALID_ARGUMENT, done)
        );
      });

      it('should fail to stage a volume with missing access mode' + ' - ' + protoname, (done) => {
        const args = getDefaultArgs();
        args.volume_capability.access_mode = {};
        client.nodeStageVolume(
          args,
          shouldFailWith(grpc.status.INVALID_ARGUMENT, done)
        );
      });

      it('should fail to stage a volume with missing volume_capability section' + ' - ' + protoname, (done) => {
        const args = getDefaultArgs();
        delete args.volume_capability;
        client.nodeStageVolume(
          args,
          shouldFailWith(grpc.status.INVALID_ARGUMENT, done)
        );
      });

      it('should be able to unstage volume (xfs)' + ' - ' + protoname, (done) => {
        client.nodeUnstageVolume(
          {
            volume_id: UUID1,
            staging_target_path: mountTarget
          },
          (err) => {
            if (err) return done(err);
            assert.isUndefined(getFsType(mountTarget));
            done();
          }
        );
      });
    });

    describe('stage and unstage ext4 volume' + ' - ' + protoname, function () {
      var client;
      var mountTarget = '/tmp/target1';

      before((done) => {
        client = createCsiClient('Node');
        cleanPublishDir(mountTarget, () => {
          createPublishDir(mountTarget);
          done();
        });
      });

      after((done) => {
        if (client != null) {
          client.close();
        }
        cleanPublishDir(mountTarget, done);
      });

      it('should be able to stage volume (ext4)' + ' - ' + protoname, (done) => {
        client.nodeStageVolume(
          {
            volume_id: UUID2,
            publish_context: publishedUris.get(UUID2),
            staging_target_path: mountTarget,
            volume_capability: {
              access_mode: {
                mode: 'MULTI_NODE_READER_ONLY'
              },
              mount: {
                fs_type: 'ext4'
              }
            },
            readonly: false,
            secrets: {},
            volume_context: {}
          },
          (err) => {
            if (err) return done(err);
            assert.equal(getFsType(mountTarget), 'ext4');
            done();
          }
        );
      });

      it('should be able to unstage volume (ext4)' + ' - ' + protoname, (done) => {
        client.nodeUnstageVolume(
          {
            volume_id: UUID2,
            staging_target_path: mountTarget
          },
          (err) => {
            if (err) return done(err);
            assert.isUndefined(getFsType(mountTarget));
            done();
          }
        );
      });
    });

    describe('stage misc' + ' - ' + protoname, function () {
      var client;
      var mountTarget = '/tmp/target2';

      before((done) => {
        client = createCsiClient('Node');
        cleanPublishDir(mountTarget, () => {
          createPublishDir(mountTarget);
          done();
        });
      });

      after((done) => {
        if (client != null) {
          client.close();
        }
        cleanPublishDir(mountTarget, done);
      });

      it('should fail to stage unsupported fs' + ' - ' + protoname, (done) => {
        const args = {
          volume_id: UUID3,
          publish_context: publishedUris.get(UUID3),
          staging_target_path: mountTarget,
          volume_capability: {
            access_mode: {
              mode: 'MULTI_NODE_READER_ONLY'
            },
            mount: {
              fs_type: 'ext3'
            }
          }
        };
        client.nodeStageVolume(
          args,
          shouldFailWith(grpc.status.INVALID_ARGUMENT, done)
        );
      });
    });

    // The combinations of ro/rw and access mode flags are quite confusing.
    // See the source code for more info on how this should work.
    describe('publish and unpublish' + ' - ' + protoname, function () {
      var client;

      before(() => {
        client = createCsiClient('Node');
      });

      after(() => {
        if (client != null) {
          client.close();
        }
      });

      describe('MULTI_NODE_READER_ONLY staged volume' + ' - ' + protoname, function () {
        var mountTarget = '/tmp/target3';
        var bindTarget1 = '/tmp/bind1';
        var bindTarget2 = '/tmp/bind2';

        before((done) => {
          const stageArgs = {
            volume_id: UUID4,
            publish_context: publishedUris.get(UUID4),
            staging_target_path: mountTarget,
            volume_capability: {
              access_mode: {
                mode: 'MULTI_NODE_READER_ONLY'
              },
              mount: {
                fs_type: 'xfs'
              }
            },
            readonly: false,
            secrets: {},
            volume_context: {}
          };

          cleanPublishDir(mountTarget, () => {
            createPublishDir(mountTarget);
            client.nodeStageVolume(stageArgs, done);
          });
        });

        after((done) => {
          async.series(
            [
              (next) => {
                client.nodeUnstageVolume(
                  {
                    volume_id: UUID4,
                    staging_target_path: mountTarget
                  },
                  next
                );
              },
              (next) => {
                cleanPublishDir(mountTarget, next);
              },
              (next) => {
                cleanPublishDir(bindTarget1, next);
              },
              (next) => {
                cleanPublishDir(bindTarget2, next);
              }
            ],
            done
          );
        });

        it('should publish a volume in ro mode and test it is idempotent op' + ' - ' + protoname, (done) => {
          const args = {
            volume_id: UUID4,
            publish_context: publishedUris.get(UUID4),
            staging_target_path: mountTarget,
            target_path: bindTarget1,
            volume_capability: {
              access_mode: {
                mode: 'MULTI_NODE_READER_ONLY'
              },
              mount: {
                fs_type: 'xfs'
              }
            },
            readonly: true
          };

          client.nodePublishVolume(args, (err) => {
            if (err) return done(err);
            assert.equal(getFsType(bindTarget1), 'xfs');
            // re-publish should succeed (idempotent)
            client.nodePublishVolume(args, done);
          });
        });

        it('should fail when re-publishing with a different staging path' + ' - ' + protoname, (done) => {
          const args = {
            volume_id: UUID4,
            publish_context: publishedUris.get(UUID4),
            staging_target_path: '/invalid_staging_path',
            target_path: bindTarget1,
            volume_capability: {
              access_mode: {
                mode: 'MULTI_NODE_READER_ONLY'
              },
              mount: {
                fs_type: 'xfs'
              }
            }
          };

          client.nodePublishVolume(
            args,
            shouldFailWith(grpc.status.INVALID_ARGUMENT, done)
          );
        });

        it('should fail with a missing target path' + ' - ' + protoname, (done) => {
          const args = {
            volume_id: UUID4,
            publish_context: publishedUris.get(UUID4),
            staging_target_path: mountTarget,
            volume_capability: {
              access_mode: {
                mode: 'MULTI_NODE_READER_ONLY'
              },
              mount: {
                fs_type: 'xfs'
              }
            }
          };

          client.nodePublishVolume(
            args,
            shouldFailWith(grpc.status.INVALID_ARGUMENT, done)
          );
        });

        it('should fail to publish the volume as rw' + ' - ' + protoname, (done) => {
          const args = {
            volume_id: UUID4,
            publish_context: publishedUris.get(UUID4),
            staging_target_path: mountTarget,
            target_path: bindTarget2,
            volume_capability: {
              access_mode: {
                mode: 'MULTI_NODE_READER_ONLY'
              },
              mount: {
                fs_type: 'xfs',
                mnt_flags: []
              }
            },
            readonly: false
          };

          client.nodePublishVolume(
            args,
            shouldFailWith(grpc.status.INVALID_ARGUMENT, (err) => {
              if (err) return done(err);
              assert.isUndefined(getFsType(bindTarget2));
              done();
            })
          );
        });

        it('should be able to unpublish ro volume' + ' - ' + protoname, (done) => {
          client.nodeUnpublishVolume(
            {
              volume_id: UUID4,
              target_path: bindTarget2
            },
            (err) => {
              if (err) return done(err);
              assert.isUndefined(getFsType(bindTarget2));
              done();
            }
          );
        });

        it('should be able to unpublish rw volume' + ' - ' + protoname, (done) => {
          client.nodeUnpublishVolume(
            {
              volume_id: UUID4,
              target_path: bindTarget1
            },
            (err) => {
              if (err) return done(err);
              // we cannot assert because the fs is lazily unmounted
              // assert.isUndefined(getFsType(bindTarget1));
              done();
            }
          );
        });
      });

      describe('MULTI_NODE_SINGLE_WRITER staged volume' + ' - ' + protoname, function () {
        var mountTarget = '/tmp/target4';
        var bindTarget1 = '/tmp/bind1';
        var bindTarget2 = '/tmp/bind2';

        before((done) => {
          const stageArgs = {
            volume_id: UUID5,
            publish_context: publishedUris.get(UUID5),
            staging_target_path: mountTarget,
            volume_capability: {
              access_mode: {
                mode: 'MULTI_NODE_SINGLE_WRITER'
              },
              mount: {
                fs_type: 'ext4'
              }
            },
            secrets: {},
            volume_context: {}
          };

          cleanPublishDir(mountTarget, () => {
            createPublishDir(mountTarget);
            client.nodeStageVolume(stageArgs, done);
          });
        });

        after((done) => {
          async.series(
            [
              (next) => {
                client.nodeUnstageVolume(
                  {
                    volume_id: UUID5,
                    staging_target_path: mountTarget
                  },
                  next
                );
              },
              (next) => {
                cleanPublishDir(mountTarget, next);
              },
              (next) => {
                cleanPublishDir(bindTarget1, next);
              },
              (next) => {
                cleanPublishDir(bindTarget2, next);
              }
            ],
            done
          );
        });

        it('should publish ro volume' + ' - ' + protoname, (done) => {
          const args = {
            volume_id: UUID5,
            publish_context: publishedUris.get(UUID5),
            staging_target_path: mountTarget,
            target_path: bindTarget1,
            readonly: true,
            volume_capability: {
              access_mode: {
                mode: 'MULTI_NODE_SINGLE_WRITER'
              },
              mount: {
                fs_type: 'ext4',
                mnt_flags: ['ro']
              }
            }
          };

          client.nodePublishVolume(args, (err) => {
            if (err) return done(err);
            assert.equal(getFsType(bindTarget1), 'ext4');
            // re-publish should succeed (idempotent)
            client.nodePublishVolume(args, done);
          });
        });

        it('should publish rw volume' + ' - ' + protoname, (done) => {
          const args = {
            volume_id: UUID5,
            publish_context: publishedUris.get(UUID5),
            staging_target_path: mountTarget,
            target_path: bindTarget2,
            volume_capability: {
              access_mode: {
                mode: 'MULTI_NODE_SINGLE_WRITER'
              },
              mount: {
                fs_type: 'ext4'
              }
            }
          };

          client.nodePublishVolume(args, (err) => {
            if (err) return done(err);
            assert.equal(getFsType(bindTarget2), 'ext4');
            done();
          });
        });

        it('should be able to unpublish ro volume' + ' - ' + protoname, (done) => {
          client.nodeUnpublishVolume(
            {
              volume_id: UUID5,
              target_path: bindTarget1
            },
            (err) => {
              if (err) return done(err);
              // we cannot assert because the fs is lazily unmounted
              // assert.isUndefined(getFsType(bindTarget1));
              done();
            }
          );
        });

        it('should be able to unpublish rw volume' + ' - ' + protoname, (done) => {
          client.nodeUnpublishVolume(
            {
              volume_id: UUID5,
              target_path: bindTarget2
            },
            (err) => {
              if (err) return done(err);
              assert.isUndefined(getFsType(bindTarget2));
              done();
            }
          );
        });
      });
    });
  });
}

module.exports = {
  csiGenericTest,
  csiProtocolTest
};
