FROM hpretl/iic-osic-tools@sha256:92961478ad3c4f508efb42d9ccdba12ab262eb42a14926d2bd49862230ba8521
USER root
RUN /usr/bin/python3 -m pip install --break-system-packages \
    'git+https://github.com/ghdl/ghdl.git@dc2c18aa' \
    'pyslang==9.1.0' 'pyVHDLModel==0.33.0' 'pyTooling==8.8.0'
ENV GHDL_PREFIX=/foss/tools/ghdl/lib/ghdl
ENV LD_LIBRARY_PATH=/foss/tools/iverilog/lib:/foss/tools/ghdl/lib
# IHP's bundled PDK uses the LibreLane 3 PDN and cell-list interfaces.
RUN /usr/bin/python3 -m pip install --break-system-packages 'librelane==3.0.0'
# LibreLane 3 requires Magic's `units` command, absent from base Magic 8.3.582.
RUN apt-get update && apt-get install -y --no-install-recommends tcl-dev tk-dev libx11-dev libxext-dev libncurses-dev && rm -rf /var/lib/apt/lists/*
RUN git clone --filter=blob:none https://github.com/RTimothyEdwards/magic.git /tmp/magic \
    && cd /tmp/magic && git checkout 4f53bb3091d1e4a9b2009a58f157a8a4331d4c84 \
    && ./configure --prefix=/opt/hdlview/magic --disable-opengl --disable-cairo \
    && make -j4 && make install && rm -rf /tmp/magic
