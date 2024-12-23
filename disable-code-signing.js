exports.default = async function(context) {
  // Completely skip version information setting
  if (context && context.packager) {
    context.packager.config.generateUpdatesFilesForAllChannels = false;
    context.packager.config.forceCodeSigning = false;
  }
}
