exports.up = (pgm) => {
  pgm.dropConstraint('deployments', 'deployments_tenant_artifact_environment_unique');
};

exports.down = (pgm) => {
  pgm.addConstraint('deployments', 'deployments_tenant_artifact_environment_unique', {
    unique: ['tenant_id', 'artifact_id', 'environment'],
  });
};
