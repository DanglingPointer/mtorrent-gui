FROM rust:1.90.0

RUN rustup component add clippy rustfmt

# install nextest
RUN curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C ${CARGO_HOME:-~/.cargo}/bin

# install tauri dependencies, see https://v2.tauri.app/start/prerequisites/
RUN apt-get update && apt-get install -y libwebkit2gtk-4.1-dev

# create non-root user for vscode
ARG USERNAME=devcontainer
ARG USER_UID=1000
ARG USER_GID=$USER_UID

RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME \
    #
    # [Optional] Add sudo support. Omit if you don't need to install software after connecting.
    && apt-get update \
    && apt-get install -y sudo \
    && echo $USERNAME ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME

USER $USERNAME

# install tauri cli (prebuilt binary) as non-root
RUN curl -LsSf "https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v2.9.6/cargo-tauri-x86_64-unknown-linux-gnu.tgz" -o /tmp/cargo-tauri.tgz \
    && tar -xzf /tmp/cargo-tauri.tgz -C ${CARGO_HOME:-/usr/local/cargo}/bin \
    && rm /tmp/cargo-tauri.tgz \
    && cargo-tauri --version
