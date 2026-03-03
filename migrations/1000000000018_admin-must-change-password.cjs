/**
 * Migration: Add must_change_password flag to admin_users
 * 
 * Allows forcing admins to change password on next login.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('admin_users', {
    must_change_password: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });
  // Seed user (id from existing migration) should require password change
  pgm.sql("UPDATE admin_users SET must_change_password = true WHERE username = 'admin'");
};

exports.down = (pgm) => {
  pgm.dropColumn('admin_users', 'must_change_password');
};
